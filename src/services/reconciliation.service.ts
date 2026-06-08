import type { EngineRequestLog } from "@prisma/client";

import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { trueEngine } from "@/lib/true-engine";
import { type DepositInstruction, settleDepositIntent } from "@/services/deposit.service";
import { beginEngineRequest, completeEngineRequest } from "@/services/engine-journal.service";
import type {
  BetPayload,
  EngineTxResult,
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

/**
 * Process one batch of actionable journal rows. Safe to call repeatedly. Thresholds
 * default to the Zod-validated env (RECONCILE_BATCH_SIZE / RECONCILE_STALE_AFTER_MS /
 * RECONCILE_MAX_ATTEMPTS) and can be overridden per call (e.g. in tests).
 */
export async function reconcileEngineRequests(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const env = getEnv();
  const batchSize = opts.batchSize ?? env.RECONCILE_BATCH_SIZE;
  const staleAfterMs = opts.staleAfterMs ?? env.RECONCILE_STALE_AFTER_MS;
  const maxAttempts = opts.maxAttempts ?? env.RECONCILE_MAX_ATTEMPTS;
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
  const rowLog = childLogger({
    component: "reconciler",
    operator_transaction_id: row.operatorTransactionId,
    type: row.type,
    player_id: row.playerId ?? undefined,
    provider_ref: row.providerRef ?? undefined,
    attempt: attempts,
  });
  await prisma.engineRequestLog.update({ where: { id: row.id }, data: { attempts } });

  let disposition: Disposition;
  if (row.requestPayload == null || row.type === "PLAYER_CREATE") {
    // Without the original body we cannot replay. PLAYER_CREATE is non-financial and not
    // reconciled here either.
    await setStatus(row.id, "ABANDONED", "no replayable payload");
    disposition = "abandoned";
  } else {
    switch (row.type) {
      case "BET":
        disposition = await finalizeReplay(row, await trueEngine().sendBet(asPayload<BetPayload>(row)), attempts, maxAttempts);
        break;
      case "DEPOSIT":
        disposition = await reconcileDeposit(row, attempts, maxAttempts);
        break;
      case "ROLLBACK":
        disposition = await finalizeReplay(row, await trueEngine().sendRollback(asPayload<RollbackPayload>(row)), attempts, maxAttempts);
        break;
      case "WIN":
        disposition = await reconcileWin(row, attempts, maxAttempts);
        break;
      default:
        await setStatus(row.id, "ABANDONED", `unhandled type ${row.type}`);
        disposition = "abandoned";
    }
  }

  if (disposition === "succeeded" || disposition === "compensated") {
    rowLog.info({ disposition }, "intent reconciled");
  } else if (disposition === "abandoned") {
    rowLog.error({ disposition }, "intent abandoned");
  } else {
    rowLog.warn({ disposition }, "intent still failing; will retry");
  }
  return disposition;
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

/**
 * DEPOSIT: settle idempotently. This re-runs the PSP capture (a no-op if it already
 * happened, or the FIRST capture if the process crashed before charging) and then the
 * idempotent ledger credit. A declined card means no funds were ever captured → nothing
 * is owed, so the intent is terminal.
 */
async function reconcileDeposit(row: EngineRequestLog, attempts: number, maxAttempts: number): Promise<Disposition> {
  const settlement = await settleDepositIntent(asPayload<DepositInstruction>(row));
  if (settlement.kind === "declined") {
    // No funds were captured → nothing owed. Terminal.
    await setStatus(row.id, "ABANDONED", `psp declined: ${settlement.reason ?? "card_declined"}`);
    return "abandoned";
  }
  if (settlement.kind === "pending_action") {
    // SCA/3DS not yet completed (no capture). Primary settlement is the PSP webhook; keep
    // retrying as a backstop until the attempt cap, then give up (safe — nothing captured).
    if (attempts < maxAttempts) {
      await markFailed(row.id, true, "awaiting customer action (SCA)");
      return "stillFailing";
    }
    await setStatus(row.id, "ABANDONED", "SCA not completed within attempt budget");
    return "abandoned";
  }
  return finalizeReplay(row, settlement.engine, attempts, maxAttempts);
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
