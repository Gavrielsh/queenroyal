import { Prisma, type EngineRequestLog, type PrismaClient } from "@prisma/client";

import { getPrisma } from "../prisma";

/**
 * Transaction-isolation helpers for the gateway's correctness-critical writes (the intent
 * journal / idempotency outbox). The mechanism is chosen per workload — there is no single
 * "right" isolation level:
 *
 *   - IDEMPOTENT INTENT CREATE relies on the UNIQUE constraint on operator_transaction_id
 *     (`ON CONFLICT DO NOTHING`). A unique key — NOT an isolation level — is the only thing
 *     that makes concurrent inserts of the SAME deterministic key collapse to one row, so a
 *     duplicate intent can never leak to the engine. (See engine-journal.repository.ts.)
 *   - INVARIANT-SENSITIVE READ-MODIFY-WRITE (e.g. a terminal status transition) runs under
 *     SERIALIZABLE with an explicit `SELECT … FOR UPDATE` row lock and bounded retry on
 *     serialization failures — preventing lost updates and illegal state regressions.
 *   - HIGH-THROUGHPUT OUTBOX DEQUEUE uses READ COMMITTED + `FOR UPDATE SKIP LOCKED` (the
 *     canonical queue pattern) and never holds a lock across the engine network call.
 */

/** Postgres serialization_failure (40001) / deadlock_detected (40P01) → Prisma `P2034`. */
export function isRetryableTxError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
}

/** Unique-constraint violation (Postgres 23505) → Prisma `P2002`. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Max RETRIES (beyond the first attempt) on a serialization/deadlock failure. */
  maxRetries?: number;
  /** Per-attempt transaction timeout (ms). */
  timeoutMs?: number;
  /** Max time to wait for a pooled connection before an attempt (ms). */
  maxWaitMs?: number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 5_000;

/**
 * Run an interactive transaction, automatically retrying ONLY on serialization/deadlock
 * failures (P2034) with capped, jittered backoff. `db` is injectable for tests; production
 * callers use the lazy singleton.
 */
export async function runInTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: TxOptions = {},
  db: PrismaClient = getPrisma(),
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  let attempt = 0;

  for (;;) {
    try {
      return await db.$transaction(fn, {
        isolationLevel: opts.isolationLevel ?? Prisma.TransactionIsolationLevel.Serializable,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxWait: opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      });
    } catch (err) {
      attempt += 1;
      if (!isRetryableTxError(err) || attempt > maxRetries) throw err;
      await sleep(backoffMs(attempt));
    }
  }
}

/** Convenience wrapper pinning SERIALIZABLE isolation. */
export function runSerializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: Omit<TxOptions, "isolationLevel"> = {},
  db: PrismaClient = getPrisma(),
): Promise<T> {
  return runInTransaction(fn, { ...opts, isolationLevel: Prisma.TransactionIsolationLevel.Serializable }, db);
}

export interface ClaimedEngineRequest {
  row: EngineRequestLog;
  /** The attempt number this claim represents (post-increment). */
  attempts: number;
}

/**
 * Atomically CLAIM a single actionable journal row for reconciliation, named by its
 * deterministic key.
 *
 * Uses READ COMMITTED + `FOR UPDATE SKIP LOCKED` so that, when several reconciler consumers
 * race on the same `operatorTransactionId`, exactly one wins and the rest skip instead of
 * blocking. Only rows that are still actionable (PENDING/FAILED) and under their attempt
 * budget are eligible; everything else (already SUCCEEDED/COMPENSATED/ABANDONED, missing, or
 * held by a peer) yields `null`. On a successful claim the attempt counter is incremented
 * inside the same short transaction and the lock is released immediately — the slow engine
 * call happens OUTSIDE any held lock (the lease is `updatedAt`/`attempts`, not a live lock).
 */
export async function claimEngineRequest(
  operatorTransactionId: string,
  maxAttempts: number,
  db: PrismaClient = getPrisma(),
): Promise<ClaimedEngineRequest | null> {
  return runInTransaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "engine_request_log"
        WHERE "operatorTransactionId" = ${operatorTransactionId}
          AND "status" IN ('PENDING'::"EngineRequestStatus", 'FAILED'::"EngineRequestStatus")
          AND "attempts" < ${maxAttempts}
        FOR UPDATE SKIP LOCKED
      `);
      const id = locked[0]?.id;
      if (!id) return null;

      const row = await tx.engineRequestLog.update({
        where: { id },
        data: { attempts: { increment: 1 } },
      });
      return { row, attempts: row.attempts };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    db,
  );
}

/**
 * Exponential backoff with full jitter, capped. NOTE: this `setTimeout` is a retry backoff,
 * NOT database polling — it sleeps between serialization-conflict retries, never to scan for
 * work (which the architecture forbids).
 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(2 ** attempt * 10, 200);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
