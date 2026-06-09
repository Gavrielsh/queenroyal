import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getEnv } from "../config/env";
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
 * AUTH IS A STRICT PLACEHOLDER: a single shared bearer token (X-Admin-Token === ADMIN_API_TOKEN),
 * constant-time compared. When ADMIN_API_TOKEN is unset the surface is LOCKED (403).
 * TODO(security): replace with real admin RBAC / mTLS / SSO and keep this router behind an
 * internal-only network boundary.
 */

const ADMIN_TOKEN_HEADER = "x-admin-token";

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
 * PLACEHOLDER admin auth — a constant-time shared-token check. Fails CLOSED: with no token
 * configured the whole surface is locked (403). TODO(security): replace with real RBAC/mTLS/SSO.
 */
async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const configured = getEnv().ADMIN_API_TOKEN;
  if (!configured) {
    req.log.error("admin API called but ADMIN_API_TOKEN is not configured — surface locked");
    await reply.code(403).send(errBody("ADMIN_API_DISABLED", "Admin API is not configured"));
    return;
  }
  const provided = req.headers[ADMIN_TOKEN_HEADER];
  if (typeof provided !== "string" || !constantTimeEquals(provided, configured)) {
    await reply.code(401).send(errBody("ADMIN_UNAUTHORIZED", "Invalid or missing admin credentials"));
    return;
  }
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

/**
 * Constant-time token comparison. Hash both sides to fixed-length digests first so timingSafeEqual
 * never throws on a length mismatch (and the comparison does not leak the token length).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
