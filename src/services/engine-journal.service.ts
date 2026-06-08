import { prisma } from "@/lib/prisma";

/**
 * Append-only intent journal (outbox). This is NOT financial state — it stores no
 * balances, only the deterministic idempotency key, the intent type, its status, and
 * the refs needed to reconcile. Its purpose is crash recovery: if the process dies
 * between a PSP capture and the ledger credit (or between a bet and its win), a
 * reconciliation job can replay the engine call with the SAME key (safe, idempotent).
 */

export type EngineRequestKind = "BET" | "WIN" | "DEPOSIT" | "ROLLBACK" | "PLAYER_CREATE";

export interface BeginEngineRequestArgs {
  operatorTransactionId: string;
  type: EngineRequestKind;
  playerId?: string;
  providerRef?: string;
}

/**
 * Record (or no-op on) a PENDING intent before the engine call. Idempotent on the
 * deterministic key: a retry of an already-journaled intent leaves the existing row
 * untouched (its terminal status, if any, is preserved).
 */
export async function beginEngineRequest(args: BeginEngineRequestArgs): Promise<void> {
  await prisma.engineRequestLog.upsert({
    where: { operatorTransactionId: args.operatorTransactionId },
    update: {}, // keep the first record; do not reset a prior status
    create: {
      operatorTransactionId: args.operatorTransactionId,
      type: args.type,
      status: "PENDING",
      playerId: args.playerId ?? null,
      providerRef: args.providerRef ?? null,
    },
  });
}

/** Mark a journaled intent terminal once the engine call resolves. */
export async function completeEngineRequest(
  operatorTransactionId: string,
  status: "SUCCEEDED" | "FAILED",
  ledgerTransactionId?: string,
): Promise<void> {
  await prisma.engineRequestLog.update({
    where: { operatorTransactionId },
    data: {
      status,
      ledgerTransactionId: ledgerTransactionId ?? null,
    },
  });
}
