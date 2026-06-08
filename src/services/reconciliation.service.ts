import type { EngineRequestLog } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { trueEngine } from "@/lib/true-engine";
import { beginEngineRequest, completeEngineRequest } from "@/services/engine-journal.service";
import type {
  BetPayload,
  EngineTxResult,
  PurchasePayload,
  RollbackPayload,
  TrueEngineResult,
  WinPayload,
} from "@/types/true-engine";

/**
 * Saga compensation / reconciliation. Consumes the EngineRequestLog outbox and drives
 * every orphaned intent to a terminal state.
 *
 * The two failure modes from the directive:
 *   - A BET succeeds but its WIN settlement fails → retry the win with the same key; if
 *     the win is terminally rejected, COMPENSATE by rolling back the bet's
 *     `ledger_transaction_id` so the player isn't left debited for an unpaid spin.
 *   - A PSP charge succeeds but the ledger DEPOSIT fails (network/timeout) → retry the
 *     deposit with the same key (idempotent; never re-charges the card).
 *
 * Every replay reuses the STABLE operator_transaction_id, so the engine de-duplicates
 * (CACHED / GHOST_RECOVERED) and funds are never moved twice.
 */

export interface ReconcileOptions {
  /** Max rows processed per run. */
  batchSize?: number;
  /** A PENDING row not updated within this window is treated as crashed/stuck. */
  staleAfterMs?: number;
  /** Give up (ABANDONED) after this many reconciliation attempts. */
  maxAttempts?: number;
}

export interface ReconcileSummary {
  scanned: number;
  succeeded: number;
  compensated: number;
  abandoned: number;
  stillFailing: number;
}

type Disposition = "succeeded" | "compensated" | "abandoned" | "stillFailing";

const DEFAULTS = { batchSize: 50, staleAfterMs: 60_000, maxAttempts: 10 } as const;

/** Process one batch of actionable journal rows. Safe to call repeatedly. */
export async function reconcileEngineRequests(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULTS.staleAfterMs;
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const staleCutoff = new Date(Date.now() - staleAfterMs);

  const rows = await prisma.engineRequestLog.findMany({
    where: {
      attempts: { lt: maxAttempts },
      OR: [
        { status: "FAILED" },
        { status: "PENDING", updatedAt: { lt: staleCutoff } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: batchSize,
  });

  const summary: ReconcileSummary = {
    scanned: rows.length,
    succeeded: 0,
    compensated: 0,
    abandoned: 0,
    stillFailing: 0,
  };

  for (const row of rows) {
    const disposition = await reconcileOne(row, maxAttempts);
    summary[disposition] += 1;
  }
  return summary;
}

async function reconcileOne(row: EngineRequestLog, maxAttempts: number): Promise<Disposition> {
  const attempts = row.attempts + 1;
  await prisma.engineRequestLog.update({ where: { id: row.id }, data: { attempts } });

  // Without the original body we cannot replay. PLAYER_CREATE is non-financial and not
  // reconciled here either.
  if (row.requestPayload == null || row.type === "PLAYER_CREATE") {
    await setStatus(row.id, "ABANDONED", "no replayable payload");
    return "abandoned";
  }

  switch (row.type) {
    case "BET":
      return finalizeReplay(row, await trueEngine().sendBet(asPayload<BetPayload>(row)), attempts, maxAttempts);
    case "DEPOSIT":
      return finalizeReplay(row, await trueEngine().sendPurchase(asPayload<PurchasePayload>(row)), attempts, maxAttempts);
    case "ROLLBACK":
      return finalizeReplay(row, await trueEngine().sendRollback(asPayload<RollbackPayload>(row)), attempts, maxAttempts);
    case "WIN":
      return reconcileWin(row, attempts, maxAttempts);
    default:
      await setStatus(row.id, "ABANDONED", `unhandled type ${row.type}`);
      return "abandoned";
  }
}

/** BET / DEPOSIT / ROLLBACK: a plain idempotent replay. */
async function finalizeReplay(
  row: EngineRequestLog,
  res: TrueEngineResult<EngineTxResult>,
  attempts: number,
  maxAttempts: number,
): Promise<Disposition> {
  if (res.ok) {
    await completeEngineRequest(row.operatorTransactionId, "SUCCEEDED", {
      ledgerTransactionId: res.data.ledger_transaction_id,
    });
    return "succeeded";
  }
  if (res.retryable && attempts < maxAttempts) {
    await markFailed(row.id, res.retryable, errText(res));
    return "stillFailing";
  }
  await setStatus(row.id, "ABANDONED", errText(res));
  return "abandoned";
}

/** WIN: retry first; on a terminal failure, compensate by rolling back the bet. */
async function reconcileWin(row: EngineRequestLog, attempts: number, maxAttempts: number): Promise<Disposition> {
  const res = await trueEngine().sendWin(asPayload<WinPayload>(row));
  if (res.ok) {
    await completeEngineRequest(row.operatorTransactionId, "SUCCEEDED", {
      ledgerTransactionId: res.data.ledger_transaction_id,
    });
    return "succeeded";
  }
  if (res.retryable && attempts < maxAttempts) {
    await markFailed(row.id, res.retryable, errText(res));
    return "stillFailing";
  }
  // Terminal (or exhausted): the win will never settle → roll back the originating bet.
  return compensateWin(row, attempts, maxAttempts);
}

async function compensateWin(row: EngineRequestLog, attempts: number, maxAttempts: number): Promise<Disposition> {
  const providerRef = row.providerRef;
  if (!providerRef || !row.playerId) {
    await setStatus(row.id, "ABANDONED", "win has no provider ref / player to compensate");
    return "abandoned";
  }

  const bet = await prisma.engineRequestLog.findUnique({
    where: { operatorTransactionId: `bet:${providerRef}` },
  });

  // Only roll back a bet that actually committed. If the bet is still unresolved, wait
  // for a later cycle (until the attempt cap) rather than rolling back a phantom debit.
  if (!bet || bet.status !== "SUCCEEDED" || !bet.ledgerTransactionId) {
    if (attempts < maxAttempts) {
      await markFailed(row.id, true, "awaiting bet resolution before compensation");
      return "stillFailing";
    }
    await setStatus(row.id, "ABANDONED", "no committed bet to compensate");
    return "abandoned";
  }

  const rollbackKey = `rollback:${providerRef}`;
  const rollbackPayload: RollbackPayload = {
    operator_transaction_id: rollbackKey,
    player_id: row.playerId,
    reference_transaction_id: bet.ledgerTransactionId,
    metadata: { reason: "win_settlement_failed", win_operator_transaction_id: row.operatorTransactionId },
  };
  await beginEngineRequest({
    operatorTransactionId: rollbackKey,
    type: "ROLLBACK",
    playerId: row.playerId,
    providerRef,
    requestPayload: rollbackPayload,
  });

  const rb = await trueEngine().sendRollback(rollbackPayload);
  if (rb.ok) {
    await completeEngineRequest(rollbackKey, "SUCCEEDED", { ledgerTransactionId: rb.data.ledger_transaction_id });
    await setStatus(row.id, "COMPENSATED", `bet rolled back via ${rollbackKey}`);
    return "compensated";
  }

  // Rollback itself failed — keep the win FAILED so we retry compensation next cycle.
  await completeEngineRequest(rollbackKey, "FAILED", { retryable: rb.retryable, lastError: errText(rb) });
  if (attempts < maxAttempts) {
    await markFailed(row.id, true, `rollback pending: ${errText(rb)}`);
    return "stillFailing";
  }
  await setStatus(row.id, "ABANDONED", `rollback exhausted: ${errText(rb)}`);
  return "abandoned";
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asPayload<T>(row: EngineRequestLog): T {
  return row.requestPayload as unknown as T;
}

function errText(res: Extract<TrueEngineResult<EngineTxResult>, { ok: false }>): string {
  return `${res.error.code}: ${res.error.message}`;
}

async function setStatus(
  id: string,
  status: "COMPENSATED" | "ABANDONED",
  note: string,
): Promise<void> {
  await prisma.engineRequestLog.update({ where: { id }, data: { status, lastError: note } });
}

async function markFailed(id: string, retryable: boolean, note: string): Promise<void> {
  await prisma.engineRequestLog.update({
    where: { id },
    data: { status: "FAILED", retryable, lastError: note },
  });
}
