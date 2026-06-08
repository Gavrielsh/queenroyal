import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Append-only intent journal (outbox). This is NOT financial state — it stores no
 * balances, only the deterministic idempotency key, the intent, its status, and the
 * exact request body needed to REPLAY the engine call. Its purpose is crash recovery:
 * if the process dies between a PSP capture and the ledger credit (or between a bet and
 * its win), the reconciler replays the engine call with the SAME key (safe, idempotent)
 * or compensates with a rollback.
 */

export type EngineRequestKind = "BET" | "WIN" | "DEPOSIT" | "ROLLBACK" | "PLAYER_CREATE";

export interface BeginEngineRequestArgs {
  operatorTransactionId: string;
  type: EngineRequestKind;
  playerId?: string;
  providerRef?: string;
  /** The exact body we are about to POST to the engine, stored for replay. */
  requestPayload?: unknown;
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
      ...(args.requestPayload !== undefined
        ? { requestPayload: args.requestPayload as Prisma.InputJsonValue }
        : {}),
    },
  });
}

export interface CompleteEngineRequestOpts {
  ledgerTransactionId?: string;
  /** Whether the failure is safe to retry (409/5xx/timeout). Recorded for the reconciler. */
  retryable?: boolean;
  /** Last engine error code/message, for diagnostics. */
  lastError?: string;
}

/** Mark a journaled intent terminal once the engine call resolves. */
export async function completeEngineRequest(
  operatorTransactionId: string,
  status: "SUCCEEDED" | "FAILED",
  opts: CompleteEngineRequestOpts = {},
): Promise<void> {
  await prisma.engineRequestLog.update({
    where: { operatorTransactionId },
    data: {
      status,
      ledgerTransactionId: opts.ledgerTransactionId ?? null,
      ...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
      ...(opts.lastError !== undefined ? { lastError: opts.lastError } : {}),
    },
  });
}
