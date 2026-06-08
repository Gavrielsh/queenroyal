import type { EngineRequestLog } from "@prisma/client";

import { getEnv } from "@/lib/env";
import { childLogger, type Logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { trueEngine } from "@/lib/true-engine";
import {
  type DepositInstruction,
  parseEngineRequestPayload,
  type ReplayableEngineRequestType,
} from "@/schemas/engine-payloads.schema";
import { creditConfirmedDeposit, pollDepositIntent } from "@/services/deposit.service";
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
 * The failure modes:
 *   - A BET succeeds but its WIN settlement fails → retry the win with the same key; if
 *     the win is terminally rejected, COMPENSATE by rolling back the bet's
 *     `ledger_transaction_id` so the player isn't left debited for an unpaid spin.
 *   - A DEPOSIT whose PSP capture is confirmed (webhook `succeeded`) but whose ledger
 *     credit failed → retry the credit with the same key (idempotent; never re-charges).
 *   - A DEPOSIT still PENDING past the stale window → poll the PSP directly (lost-webhook
 *     backstop): credit if it actually succeeded, abandon if it failed, else wait.
 *
 * Every replay reuses the STABLE operator_transaction_id, so the engine de-duplicates
 * (CACHED / GHOST_RECOVERED) and funds are never moved twice. Every payload is STRICTLY
 * re-validated (Zod) before replay — a corrupted JSONB row is abandoned with a critical
 * alert, never blindly forwarded to the ledger.
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

  const disposition = await dispatch(row, attempts, maxAttempts, rowLog);

  if (disposition === "succeeded" || disposition === "compensated") {
    rowLog.info({ disposition }, "intent reconciled");
  } else if (disposition === "abandoned") {
    rowLog.error({ disposition }, "intent abandoned");
  } else {
    rowLog.warn({ disposition }, "intent still failing; will retry");
  }
  return disposition;
}

async function dispatch(
  row: EngineRequestLog,
  attempts: number,
  maxAttempts: number,
  rowLog: Logger,
): Promise<Disposition> {
  // PLAYER_CREATE is non-financial and not reconciled here; a row with no payload cannot
  // be replayed at all.
  if (row.requestPayload == null || row.type === "PLAYER_CREATE") {
    await setStatus(row.id, "ABANDONED", "no replayable payload");
    return "abandoned";
  }
  if (!isReplayableType(row.type)) {
    await setStatus(row.id, "ABANDONED", `unhandled type ${row.type}`);
    return "abandoned";
  }

  // Phase 3: STRICT-validate the JSONB payload before ANY replay logic runs. A corrupted
  // row is a runtime crash (or a malformed ledger call) waiting to happen → abandon it and
  // raise a critical alert instead of trusting `Prisma.JsonValue`.
  const parsed = parseEngineRequestPayload(row.type, row.requestPayload);
  if (!parsed.ok) {
    rowLog.fatal({ alert: "corrupt_engine_payload", reason: parsed.error }, "CRITICAL: journal payload failed schema validation; abandoning");
    await setStatus(row.id, "ABANDONED", `corrupt payload: ${parsed.error}`);
    return "abandoned";
  }

  switch (parsed.type) {
    case "BET":
      return finalizeReplay(row, await trueEngine().sendBet(parsed.data), attempts, maxAttempts);
    case "ROLLBACK":
      return finalizeReplay(row, await trueEngine().sendRollback(parsed.data), attempts, maxAttempts);
    case "WIN":
      return reconcileWin(row, parsed.data, attempts, maxAttempts);
    case "DEPOSIT":
      return reconcileDeposit(row, parsed.data, attempts, maxAttempts, rowLog);
  }
}

/** BET / ROLLBACK: a plain idempotent replay. */
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
 * DEPOSIT reconciliation. The PSP is the authority on whether funds were captured:
 *   - status FAILED  → a `succeeded` webhook already confirmed capture but the ledger
 *     credit failed. Retry the credit ONLY (idempotent; never a re-charge).
 *   - status PENDING → the webhook may have been lost. Poll the PSP: credit if it actually
 *     succeeded, abandon if it failed/cancelled, else keep waiting (nothing captured yet).
 */
async function reconcileDeposit(
  row: EngineRequestLog,
  instruction: DepositInstruction,
  attempts: number,
  maxAttempts: number,
  rowLog: Logger,
): Promise<Disposition> {
  if (row.status === "FAILED") {
    return finalizeDepositCredit(row, await creditConfirmedDeposit(instruction), attempts, maxAttempts, rowLog);
  }

  // PENDING & stale → reconcile against the PSP's own view of the intent.
  const snapshot = await pollDepositIntent(instruction.paymentIntentId);
  if (!snapshot) {
    // The intent was never opened (or has expired/purged) → nothing was captured.
    return waitOrAbandon(row, attempts, maxAttempts, "psp intent not found");
  }
  if (snapshot.status === "succeeded") {
    rowLog.warn("recovered a lost PSP success via poll; crediting deposit");
    return finalizeDepositCredit(row, await creditConfirmedDeposit(instruction), attempts, maxAttempts, rowLog);
  }
  if (snapshot.status === "failed" || snapshot.status === "canceled") {
    await setStatus(row.id, "ABANDONED", `psp intent ${snapshot.status} (no capture)`);
    return "abandoned";
  }
  // requires_* / processing → the customer has not completed payment. Nothing captured.
  return waitOrAbandon(row, attempts, maxAttempts, `awaiting payment (${snapshot.status})`);
}

/**
 * Resolve a deposit credit result. Unlike a bet, a TERMINAL failure here means funds were
 * already captured but the ledger refused the credit — a money-out-of-balance condition
 * that needs human intervention (refund), so it is abandoned with a CRITICAL alert.
 */
async function finalizeDepositCredit(
  row: EngineRequestLog,
  res: TrueEngineResult<EngineTxResult>,
  attempts: number,
  maxAttempts: number,
  rowLog: Logger,
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
  rowLog.fatal({ alert: "captured_deposit_uncredited", err: errText(res) }, "CRITICAL: captured deposit could not be credited; manual refund required");
  await setStatus(row.id, "ABANDONED", `captured but uncredited: ${errText(res)}`);
  return "abandoned";
}

/**
 * Keep an uncaptured PENDING deposit alive for another cycle (NOT FAILED — that status is
 * reserved for confirmed-capture-credit-pending), or give up once the attempt budget is
 * spent. Either way no funds were captured, so abandoning is safe.
 */
async function waitOrAbandon(
  row: EngineRequestLog,
  attempts: number,
  maxAttempts: number,
  note: string,
): Promise<Disposition> {
  if (attempts < maxAttempts) {
    // Touch the row (bumps updatedAt) so it leaves the stale window and is rescanned later.
    await prisma.engineRequestLog.update({ where: { id: row.id }, data: { lastError: note } });
    return "stillFailing";
  }
  await setStatus(row.id, "ABANDONED", `${note}; attempt budget exhausted`);
  return "abandoned";
}

/** WIN: retry first; on a terminal failure, compensate by rolling back the bet. */
async function reconcileWin(
  row: EngineRequestLog,
  payload: WinPayload,
  attempts: number,
  maxAttempts: number,
): Promise<Disposition> {
  const res = await trueEngine().sendWin(payload);
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

function isReplayableType(type: EngineRequestLog["type"]): type is ReplayableEngineRequestType {
  return type === "BET" || type === "WIN" || type === "DEPOSIT" || type === "ROLLBACK";
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
