import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getEnv } from "../config/env";
import { AdminRoleError, verifyAdminToken } from "../lib/jwt";
import { getPrisma } from "../lib/prisma";
import { getReconcileQueue, type ReconcileQueue, ReconcileQueueUnavailableError } from "../lib/reconcile-queue";
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

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/admin/dlq", { preHandler: requireAdmin }, listAbandonedHandler);
  app.post("/api/admin/dlq/:id/replay", { preHandler: requireAdmin }, replayHandler);
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

  // Bind the operator identity to the request log so every admin action is attributable.
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
