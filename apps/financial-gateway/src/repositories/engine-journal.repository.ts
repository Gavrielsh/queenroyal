import { Prisma, type EngineRequestLog } from "@prisma/client";

import { runInTransaction, runSerializable } from "../lib/db/transaction";
import { getPrisma } from "../lib/prisma";

/**
 * Intent-journal / idempotency-outbox data access — the ONLY writer of engine_request_log.
 * No balances, ever: just the deterministic idempotency key, the intent, its status, and the
 * refs/payload needed to replay the engine call. This module owns the isolation guarantees;
 * callers (route handlers in Phase 3, the reconciler in Phase 5) use its API and stay out of
 * raw SQL.
 */

export type EngineRequestKind = "BET" | "WIN" | "DEPOSIT" | "ROLLBACK" | "PLAYER_CREATE";

/** Statuses from which an intent must NEVER regress (already settled / given up). */
const FINAL_STATUSES: ReadonlySet<string> = new Set(["SUCCEEDED", "COMPENSATED", "ABANDONED"]);

export class IntentNotFoundError extends Error {
  constructor(public readonly operatorTransactionId: string) {
    super(`no engine_request_log row for operator_transaction_id=${operatorTransactionId}`);
    this.name = "IntentNotFoundError";
  }
}

export interface CreateIntentArgs {
  operatorTransactionId: string;
  type: EngineRequestKind;
  playerId?: string;
  providerRef?: string;
  /** Exact body to be POSTed to the engine, stored verbatim for idempotent replay. */
  requestPayload?: unknown;
}

/**
 * Idempotently record a PENDING intent BEFORE the engine call. Race-proof by construction:
 * the UNIQUE constraint on operator_transaction_id + `ON CONFLICT DO NOTHING` (Prisma
 * `createMany({ skipDuplicates })`) guarantees two concurrent inserts of the same
 * deterministic key collapse to a single row — so a retried or duplicated webhook can never
 * spawn a second intent. Returns whether THIS call created the row (informational: callers
 * proceed to the idempotent engine call regardless, since the engine de-duplicates too).
 */
export async function createIntentIfAbsent(args: CreateIntentArgs): Promise<{ created: boolean }> {
  const result = await getPrisma().engineRequestLog.createMany({
    data: [
      {
        operatorTransactionId: args.operatorTransactionId,
        type: args.type,
        status: "PENDING",
        playerId: args.playerId ?? null,
        providerRef: args.providerRef ?? null,
        ...(args.requestPayload !== undefined
          ? { requestPayload: args.requestPayload as Prisma.InputJsonValue }
          : {}),
      },
    ],
    skipDuplicates: true,
  });
  return { created: result.count === 1 };
}

export interface MarkTerminalOpts {
  ledgerTransactionId?: string;
  retryable?: boolean;
  lastError?: string;
}

/**
 * Transition a journaled intent to a status that is terminal-for-this-attempt (SUCCEEDED or
 * FAILED) under SERIALIZABLE isolation with an explicit `SELECT … FOR UPDATE` row lock. The
 * lock + isolation make the read-check-write atomic, so a late duplicate completion (or a
 * request handler racing the reconciler) can never regress an already-final intent
 * (SUCCEEDED / COMPENSATED / ABANDONED) — a regression there would mean lying about money
 * that already moved at the engine. Idempotent: re-marking an already-final intent is a no-op.
 */
export async function markIntentTerminal(
  operatorTransactionId: string,
  status: "SUCCEEDED" | "FAILED",
  opts: MarkTerminalOpts = {},
): Promise<{ updated: boolean }> {
  return runSerializable(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status"
      FROM "engine_request_log"
      WHERE "operatorTransactionId" = ${operatorTransactionId}
      FOR UPDATE
    `);

    const current = rows[0];
    if (!current) throw new IntentNotFoundError(operatorTransactionId);
    if (FINAL_STATUSES.has(current.status)) return { updated: false };

    await tx.engineRequestLog.update({
      where: { operatorTransactionId },
      data: {
        status,
        ...(opts.ledgerTransactionId !== undefined ? { ledgerTransactionId: opts.ledgerTransactionId } : {}),
        ...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
        ...(opts.lastError !== undefined ? { lastError: opts.lastError } : {}),
      },
    });
    return { updated: true };
  });
}

export interface ClaimOptions {
  batchSize: number;
  /** A row is only (re)claimable once `updatedAt` is older than this — it acts as the lease. */
  staleAfterMs: number;
  maxAttempts: number;
}

/**
 * Atomically CLAIM a batch of reconcilable intents for exactly-one-worker processing.
 *
 * `FOR UPDATE SKIP LOCKED` ensures concurrent workers never select the same rows; bumping
 * `attempts` (which also advances `updatedAt` via @updatedAt) "leases" the rows out of the
 * staleness window before COMMIT. Crucially the row lock is released at commit — the slow
 * engine network call happens AFTER this returns, never while a lock is held. A worker that
 * crashes mid-process simply lets the lease expire (updatedAt ages past `staleAfterMs`) and
 * the row is re-claimed later: at-least-once delivery, made safe by the engine's own
 * idempotency on operator_transaction_id.
 *
 * READ COMMITTED is deliberate: SKIP LOCKED already provides the concurrency guarantee, so
 * SERIALIZABLE here would only add needless 40001 retries under load.
 */
export async function claimReconcilableBatch(opts: ClaimOptions): Promise<EngineRequestLog[]> {
  const staleCutoff = new Date(Date.now() - opts.staleAfterMs);

  return runInTransaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "engine_request_log"
        WHERE "attempts" < ${opts.maxAttempts}
          AND "updatedAt" < ${staleCutoff}
          AND "status" IN ('PENDING'::"EngineRequestStatus", 'FAILED'::"EngineRequestStatus")
        ORDER BY "updatedAt" ASC
        LIMIT ${opts.batchSize}
        FOR UPDATE SKIP LOCKED
      `);

      if (locked.length === 0) return [];
      const ids = locked.map((row) => row.id);

      await tx.engineRequestLog.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 } },
      });

      return tx.engineRequestLog.findMany({
        where: { id: { in: ids } },
        orderBy: { updatedAt: "asc" },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
