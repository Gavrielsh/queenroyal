import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getEnv } from "../config/env";
import { AdminRoleError, verifyAdminToken } from "../lib/jwt";
import { getPrisma } from "../lib/prisma";
import { getReconcileQueue, type ReconcileQueue, ReconcileQueueUnavailableError } from "../lib/reconcile-queue";
import { getRedemptionQueue, RedemptionQueueUnavailableError } from "../lib/redemption-queue";
import { errBody, okBody } from "../lib/reply";

/**
 * Admin / Day-2 operations API for DEAD-LETTER-QUEUE management.
 *
 * The reconciler parks terminally-failed intents as `ABANDONED` (the application-level DLQ).
 * These endpoints let an operator (a) inspect abandoned intents and (b) REPLAY one.
 *
 * Replay is NOT a simple status flip: the reconciler is event-driven and only ever CLAIMS rows
 * that are `PENDING`/`FAILED` AND under their attempt budget (see lib/db/transaction.ts). So a
 * replay must resurrect the row to `PENDING`, RESET its exhausted attempt counter, and re-emit a
 * reconcile event onto the broker so the worker actually re-drives it. It fails CLOSED (503) when
 * the broker is unavailable, rolling the row back so it stays a replayable `ABANDONED` rather than
 * a stuck `PENDING` with no event to drive it.
 *
 * AUTH: JWT-based admin authentication. Every request must carry `Authorization: Bearer <jwt>`
 * where the token is HS256-signed with the DEDICATED ADMIN_JWT_SECRET (never the player
 * JWT_SECRET) and asserts the `role: "admin"` claim. Fails CLOSED: when ADMIN_JWT_SECRET is
 * unset the surface is LOCKED (403). Keep this router behind an internal-only network boundary
 * regardless — auth is a layer, not the perimeter.
 */

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const replayParamsSchema = z.object({
  id: z.string().min(1),
});

/**
 * An approval may carry an optional note. A REJECTION may not be silent: `decisionReason` is
 * REQUIRED and non-trivial, because it is the record a regulator asks for when a player
 * disputes a refused payout. "Because the operator said so" is not a defence.
 */
const approveBodySchema = z.object({
  decisionReason: z.string().trim().min(1).max(500).optional(),
});

const rejectBodySchema = z.object({
  decisionReason: z.string().trim().min(3, "decisionReason is required when rejecting").max(500),
});

/** Per-request admin identity, populated by requireAdmin BEFORE the handler runs. */
declare module "fastify" {
  interface FastifyRequest {
    adminSub: string | null;
  }
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.decorateRequest("adminSub", null);
  app.get("/api/admin/dlq", { preHandler: requireAdmin }, listAbandonedHandler);
  app.post("/api/admin/dlq/:id/replay", { preHandler: requireAdmin }, replayHandler);
  // Redemption review — the producer for the payout worker.
  app.post("/api/admin/redemptions/:id/approve", { preHandler: requireAdmin }, approveRedemptionHandler);
  app.post("/api/admin/redemptions/:id/reject", { preHandler: requireAdmin }, rejectRedemptionHandler);
};

/**
 * JWT admin auth. Verifies the `Authorization: Bearer` token against ADMIN_JWT_SECRET (HS256
 * only) and asserts the `role: "admin"` claim. Fails CLOSED: with no secret configured the
 * whole surface is locked (403). A cryptographically-valid token WITHOUT the admin role is a
 * distinct 403 (authenticated but not authorised), never a 401.
 */
async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!getEnv().ADMIN_JWT_SECRET) {
    req.log.error("admin API called but ADMIN_JWT_SECRET is not configured — surface locked");
    await reply.code(403).send(errBody("ADMIN_API_DISABLED", "Admin API is not configured"));
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    await reply.code(401).send(errBody("ADMIN_UNAUTHORIZED", "Invalid or missing admin credentials"));
    return;
  }
  const token = header.slice("Bearer ".length).trim();

  let claims;
  try {
    claims = verifyAdminToken(token);
  } catch (err) {
    if (err instanceof AdminRoleError) {
      await reply.code(403).send(errBody("ADMIN_FORBIDDEN", "Token does not grant admin access"));
      return;
    }
    // Anything else (bad signature, expired, malformed) is an authentication failure. The
    // verify error itself is never echoed to the caller.
    await reply.code(401).send(errBody("ADMIN_UNAUTHORIZED", "Invalid or missing admin credentials"));
    return;
  }

  // Bind the operator identity to the request log AND to the request, so every admin action is
  // attributable both in the logs and in the row it writes.
  req.adminSub = claims.sub;
  req.log = req.log.child({ admin_sub: claims.sub });
}

/** GET /api/admin/dlq — page through intents currently parked as ABANDONED. */
async function listAbandonedHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid pagination", parsed.error.flatten()));
    return;
  }
  const { limit, offset } = parsed.data;
  const prisma = getPrisma();

  const [total, items] = await Promise.all([
    prisma.engineRequestLog.count({ where: { status: "ABANDONED" } }),
    prisma.engineRequestLog.findMany({
      where: { status: "ABANDONED" },
      orderBy: { updatedAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        operatorTransactionId: true,
        type: true,
        status: true,
        playerId: true,
        providerRef: true,
        ledgerTransactionId: true,
        retryable: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  await reply.code(200).send(okBody({ items, pagination: { limit, offset, total } }));
}

/** POST /api/admin/dlq/:id/replay — resurrect an ABANDONED intent and re-enqueue it. */
async function replayHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = replayParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid transaction id", parsed.error.flatten()));
    return;
  }
  const { id } = parsed.data;
  const prisma = getPrisma();

  const row = await prisma.engineRequestLog.findUnique({ where: { id } });
  if (!row) {
    await reply.code(404).send(errBody("NOT_FOUND", "No transaction with that id"));
    return;
  }
  if (row.status !== "ABANDONED") {
    await reply.code(409).send(errBody("NOT_REPLAYABLE", `Only ABANDONED transactions can be replayed (current: ${row.status})`));
    return;
  }

  // Resolve the broker BEFORE mutating — fail closed (503) if the event bus is unavailable, so we
  // never resurrect a row we cannot actually re-enqueue.
  let queue: ReconcileQueue;
  try {
    queue = getReconcileQueue();
  } catch (err) {
    if (err instanceof ReconcileQueueUnavailableError) {
      await reply.code(503).send(errBody("QUEUE_UNAVAILABLE", "Reconcile broker unavailable"));
      return;
    }
    throw err;
  }

  // Resurrect ABANDONED → PENDING and RESET the exhausted attempt counter so the reconciler's
  // claim filter (status IN (PENDING,FAILED) AND attempts < max) makes it eligible again. Guarded
  // on the current ABANDONED status so a concurrent replay can't double-resurrect.
  const reset = await prisma.engineRequestLog.updateMany({
    where: { id, status: "ABANDONED" },
    data: { status: "PENDING", attempts: 0, retryable: false, lastError: "admin replay requested" },
  });
  if (reset.count === 0) {
    await reply.code(409).send(errBody("NOT_REPLAYABLE", "Transaction was concurrently modified"));
    return;
  }

  try {
    await queue.publish({ operatorTransactionId: row.operatorTransactionId, reason: "admin-replay" });
  } catch (err) {
    // Roll the resurrection back so the row stays a (replayable) ABANDONED, not a stuck PENDING
    // with no event to drive it.
    await prisma.engineRequestLog.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "ABANDONED", lastError: "admin replay enqueue failed" },
    });
    req.log.error({ err, id }, "admin replay enqueue failed; rolled back to ABANDONED");
    await reply.code(503).send(errBody("QUEUE_UNAVAILABLE", "Failed to enqueue replay"));
    return;
  }

  req.log.warn({ id, operator_transaction_id: row.operatorTransactionId }, "admin replayed abandoned transaction");
  await reply.code(200).send(
    okBody({ id, operatorTransactionId: row.operatorTransactionId, status: "PENDING", enqueued: true }),
  );
}

// ── Redemption review ────────────────────────────────────────────────────────

/**
 * POST /api/admin/redemptions/:id/approve
 *
 * UNDER_REVIEW → APPROVED, then enqueue for the payout worker. This is the producer the worker
 * has been waiting for.
 *
 * FAILS CLOSED, and rolls back. The broker is resolved BEFORE the row is touched, and if the
 * publish itself fails the approval is reverted to UNDER_REVIEW — mirroring the DLQ replay
 * above for the same reason: an APPROVED row with no event to drive it is a payout that silently
 * never happens, which is worse than a visible failure the operator can retry.
 *
 * The transition is a compare-and-set on UNDER_REVIEW, so two operators clicking approve at the
 * same moment produce one approval and one 409 — never two enqueued payouts.
 */
async function approveRedemptionHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = replayParamsSchema.safeParse(req.params);
  if (!params.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid redemption id", params.error.flatten()));
    return;
  }
  const body = approveBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid approval payload", body.error.flatten()));
    return;
  }

  const { id } = params.data;
  const prisma = getPrisma();
  const row = await prisma.redemptionRequest.findUnique({ where: { id } });
  if (!row) {
    await reply.code(404).send(errBody("NOT_FOUND", "No redemption with that id"));
    return;
  }
  if (row.status !== "UNDER_REVIEW") {
    await reply
      .code(409)
      .send(errBody("NOT_REVIEWABLE", `Only UNDER_REVIEW redemptions can be approved (current: ${row.status})`));
    return;
  }

  // Resolve the broker before mutating, so we never approve something we cannot enqueue.
  let queue;
  try {
    queue = getRedemptionQueue();
  } catch (err) {
    if (err instanceof RedemptionQueueUnavailableError) {
      await reply.code(503).send(errBody("QUEUE_UNAVAILABLE", "Redemption broker unavailable"));
      return;
    }
    throw err;
  }

  const approved = await prisma.redemptionRequest.updateMany({
    where: { id, status: "UNDER_REVIEW" },
    data: {
      status: "APPROVED",
      statusChangedAt: new Date(),
      reviewedBy: req.adminSub,
      reviewedAt: new Date(),
      ...(body.data.decisionReason ? { decisionReason: body.data.decisionReason } : {}),
    },
  });
  if (approved.count === 0) {
    await reply.code(409).send(errBody("NOT_REVIEWABLE", "Redemption was concurrently modified"));
    return;
  }

  try {
    await queue.publish({ operatorTransactionId: id, reason: "admin-approved" });
  } catch (err) {
    await prisma.redemptionRequest.updateMany({
      where: { id, status: "APPROVED" },
      data: { status: "UNDER_REVIEW", statusChangedAt: new Date(), decisionReason: "approval enqueue failed" },
    });
    req.log.error({ err, redemption_id: id }, "redemption approval enqueue failed; rolled back to UNDER_REVIEW");
    await reply.code(503).send(errBody("QUEUE_UNAVAILABLE", "Failed to enqueue the approved redemption"));
    return;
  }

  req.log.info({ redemption_id: id }, "redemption approved and enqueued for payout");
  await reply.code(200).send(okBody({ id, status: "APPROVED", reviewedBy: req.adminSub }));
}

/**
 * POST /api/admin/redemptions/:id/reject
 *
 * UNDER_REVIEW → REJECTED with a MANDATORY reason. Nothing is enqueued: a rejected redemption
 * has no payout to make.
 *
 * NOTE ON THE MONEY, because this is the sharp edge. The SC was debited in Zone 1 when the
 * player asked. Rejecting the request does NOT give it back — restoring it needs a compensating
 * credit in Zone 1, which does not exist yet. The row records who refused it and why so the
 * obligation is visible and attributable; discharging that obligation is a separate, deliberate
 * act and must not be inferred from this status.
 */
async function rejectRedemptionHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = replayParamsSchema.safeParse(req.params);
  if (!params.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid redemption id", params.error.flatten()));
    return;
  }
  const body = rejectBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "A decisionReason is required", body.error.flatten()));
    return;
  }

  const { id } = params.data;
  const prisma = getPrisma();
  const row = await prisma.redemptionRequest.findUnique({ where: { id } });
  if (!row) {
    await reply.code(404).send(errBody("NOT_FOUND", "No redemption with that id"));
    return;
  }
  if (row.status !== "UNDER_REVIEW") {
    await reply
      .code(409)
      .send(errBody("NOT_REVIEWABLE", `Only UNDER_REVIEW redemptions can be rejected (current: ${row.status})`));
    return;
  }

  const rejected = await prisma.redemptionRequest.updateMany({
    where: { id, status: "UNDER_REVIEW" },
    data: {
      status: "REJECTED",
      statusChangedAt: new Date(),
      reviewedBy: req.adminSub,
      reviewedAt: new Date(),
      decisionReason: body.data.decisionReason,
    },
  });
  if (rejected.count === 0) {
    await reply.code(409).send(errBody("NOT_REVIEWABLE", "Redemption was concurrently modified"));
    return;
  }

  req.log.warn({ redemption_id: id, reason: body.data.decisionReason }, "redemption rejected by operator");
  await reply.code(200).send(okBody({ id, status: "REJECTED", reviewedBy: req.adminSub }));
}
