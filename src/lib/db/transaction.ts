import { Prisma, type EngineRequestLog, type PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Transaction-isolation + row-locking helpers for the intent journal / idempotency outbox
 * (Phase 2 locking contract, consumed by the Phase 5 event-driven reconciler).
 *
 * Two distinct mechanisms, chosen per workload:
 *   - OUTBOX CLAIM — {@link claimEngineRequest} dequeues a single actionable row under
 *     READ COMMITTED + `SELECT … FOR UPDATE SKIP LOCKED`. This is the canonical queue
 *     pattern: concurrent reconciler consumers never block on, nor double-process, the same
 *     row — a row already locked by a peer is simply skipped. The lock is held only for the
 *     claim (an attempt-counter bump), NEVER across the engine network call.
 *   - INVARIANT-SENSITIVE WRITES — {@link runSerializable} pins SERIALIZABLE and retries only
 *     on serialization/deadlock failures, so a late webhook can't regress a settled intent.
 */

/** Postgres serialization_failure (40001) / deadlock_detected (40P01) → Prisma `P2034`. */
export function isRetryableTxError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
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
 * failures (P2034) with capped, jittered backoff. `db` is injectable for tests.
 */
export async function runInTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: TxOptions = {},
  db: PrismaClient = prisma,
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

/** Convenience wrapper pinning SERIALIZABLE isolation for invariant-sensitive writes. */
export function runSerializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: Omit<TxOptions, "isolationLevel"> = {},
  db: PrismaClient = prisma,
): Promise<T> {
  return runInTransaction(fn, { ...opts, isolationLevel: Prisma.TransactionIsolationLevel.Serializable }, db);
}

export interface ClaimedEngineRequest {
  row: EngineRequestLog;
  /** The attempt number this claim represents (post-increment). */
  attempts: number;
}

/**
 * Atomically CLAIM a single actionable journal row for reconciliation.
 *
 * Uses READ COMMITTED + `FOR UPDATE SKIP LOCKED` so that, when several reconciler consumers
 * race on the same `operator_transaction_id`, exactly one wins and the rest skip instead of
 * blocking. Only rows that are still actionable (PENDING/FAILED) and under their attempt
 * budget are eligible; everything else (already SUCCEEDED/COMPENSATED/ABANDONED, missing, or
 * locked by a peer) yields `null`. On a successful claim the attempt counter is incremented
 * inside the same short transaction, and the lock is released immediately — the engine call
 * happens OUTSIDE any held lock.
 */
export async function claimEngineRequest(
  operatorTransactionId: string,
  maxAttempts: number,
  db: PrismaClient = prisma,
): Promise<ClaimedEngineRequest | null> {
  return runInTransaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM engine_request_log
        WHERE operator_transaction_id = ${operatorTransactionId}
          AND status IN ('PENDING', 'FAILED')
          AND attempts < ${maxAttempts}
        FOR UPDATE SKIP LOCKED
      `;
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
 * Backoff between serialization-conflict retries. NOTE: this `setTimeout` is a retry sleep,
 * NOT database polling — it never scans for work (which the architecture forbids).
 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(2 ** attempt * 10, 200);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
