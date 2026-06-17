import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { claimEngineRequest } from "../src/lib/db/transaction";

/**
 * Concurrency-safety proof for the reconciler's outbox CLAIM (Milestone-1 Task 3 DoD:
 * "multiple worker instances do not process the same operator_transaction_id simultaneously").
 *
 * The guarantee is Postgres `SELECT … FOR UPDATE SKIP LOCKED`: a row locked by one claimer's
 * open transaction is INVISIBLE to a racing claimer, which skips it instead of blocking. The
 * shared in-memory Prisma fake can't model row locks, so this suite injects a purpose-built
 * Postgres-faithful double via {@link claimEngineRequest}'s `db` seam:
 *   - the lock is acquired SYNCHRONOUSLY inside the claim SELECT (before any await), exactly as
 *     `FOR UPDATE` takes the lock the instant the row is read;
 *   - it is held until the surrounding transaction settles (commit/rollback), then released;
 *   - a concurrent SELECT that finds the row already locked returns no rows (SKIP LOCKED).
 * Two overlapping claims for the same key therefore yield exactly one winner.
 */

interface JournalRow {
  id: string;
  operatorTransactionId: string;
  status: "PENDING" | "FAILED" | "SUCCEEDED" | "COMPENSATED" | "ABANDONED";
  attempts: number;
}

/** Pull the bound parameter values out of a `Prisma.sql` fragment (`.values`). */
function sqlValues(q: unknown): unknown[] {
  return (q as { values?: unknown[] }).values ?? [];
}

/**
 * A single-row journal that honors `FOR UPDATE SKIP LOCKED`. Returns the injectable `db` plus a
 * read-only view of the row so a test can assert how many times it was actually claimed.
 */
function contendedJournal(seed: JournalRow): { db: PrismaClient; snapshot: () => JournalRow } {
  const row: JournalRow = { ...seed };
  const lockedRowIds = new Set<string>();

  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const heldByThisTx: string[] = [];
      const tx = {
        // Models the claim's `SELECT "id" … FOR UPDATE SKIP LOCKED`.
        $queryRaw: async (q: unknown): Promise<Array<{ id: string }>> => {
          const [operatorTransactionId, maxAttempts] = sqlValues(q) as [string, number];
          if (row.operatorTransactionId !== operatorTransactionId) return [];
          const actionable = row.status === "PENDING" || row.status === "FAILED";
          if (!actionable || row.attempts >= maxAttempts) return [];
          // FOR UPDATE takes the row lock the moment it is read; a peer holding it → SKIP LOCKED.
          // Acquired synchronously (no await above) so two racing claims can't both acquire.
          if (lockedRowIds.has(row.id)) return [];
          lockedRowIds.add(row.id);
          heldByThisTx.push(row.id);
          await Promise.resolve(); // model the round-trip AFTER the lock is held
          return [{ id: row.id }];
        },
        engineRequestLog: {
          update: async ({ where, data }: { where: { id: string }; data: { attempts?: { increment: number } } }) => {
            if (where.id !== row.id) throw new Error(`unexpected update target ${where.id}`);
            if (data.attempts?.increment) row.attempts += data.attempts.increment;
            return { ...row };
          },
        },
      };
      try {
        return await fn(tx);
      } finally {
        // Locks are released when the transaction settles (commit OR rollback).
        for (const id of heldByThisTx) lockedRowIds.delete(id);
      }
    },
  } as unknown as PrismaClient;

  return { db, snapshot: () => ({ ...row }) };
}

describe("reconciler claim — concurrency safety (FOR UPDATE SKIP LOCKED)", () => {
  it("two workers racing the SAME operator_transaction_id: exactly one claims it", async () => {
    const { db, snapshot } = contendedJournal({
      id: "row-1",
      operatorTransactionId: "bet:race-1",
      status: "FAILED",
      attempts: 0,
    });

    const [a, b] = await Promise.all([
      claimEngineRequest("bet:race-1", 5, db),
      claimEngineRequest("bet:race-1", 5, db),
    ]);

    const winners = [a, b].filter((c): c is NonNullable<typeof c> => c !== null);
    expect(winners).toHaveLength(1); // the other worker SKIP-LOCKED and got null
    expect(winners[0]!.row.operatorTransactionId).toBe("bet:race-1");
    expect(winners[0]!.attempts).toBe(1);
    expect(snapshot().attempts).toBe(1); // engine attempt counter advanced exactly once
  });

  it("ten concurrent workers on one intent: a single claim wins, attempts bumped once", async () => {
    const { db, snapshot } = contendedJournal({
      id: "row-2",
      operatorTransactionId: "win:race-2",
      status: "PENDING",
      attempts: 0,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimEngineRequest("win:race-2", 5, db)),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(snapshot().attempts).toBe(1);
  });

  it("a terminal (SUCCEEDED) intent is never claimed — no re-processing of settled money", async () => {
    const { db } = contendedJournal({
      id: "row-3",
      operatorTransactionId: "deposit:done",
      status: "SUCCEEDED",
      attempts: 1,
    });
    expect(await claimEngineRequest("deposit:done", 5, db)).toBeNull();
  });

  it("an intent over its attempt budget is not claimed (it belongs in the DLQ, not a retry)", async () => {
    const { db } = contendedJournal({
      id: "row-4",
      operatorTransactionId: "bet:exhausted",
      status: "FAILED",
      attempts: 5,
    });
    expect(await claimEngineRequest("bet:exhausted", 5, db)).toBeNull();
  });
});
