import type { EngineRequestLog } from "@prisma/client";

import { getEnv } from "../config/env";
import { claimEngineRequest } from "../lib/db/transaction";
import { childLogger, type Logger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import {
  getReconcileQueue,
  type ReconcileMessage,
  type ReconcileQueue,
} from "../lib/reconcile-queue";
import { trueEngine } from "../lib/true-engine";
import {
  type DepositInstruction,
  parseEngineRequestPayload,
  type ReplayableEngineRequestType,
} from "../schemas/engine-payloads.schema";
import type {
  EngineTxResult,
  RollbackPayload,
  TrueEngineResult,
  WinPayload,
} from "../types/true-engine";
import { creditConfirmedDeposit, pollDepositIntent } from "./deposit.service";
import { beginEngineRequest, completeEngineRequest } from "./engine-journal.service";

/**
 * Saga compensation / reconciliation — EVENT-DRIVEN (Phase 5). This now lives INSIDE the
 * gateway workspace: the gateway owns both the producer (enqueue/schedule on the spin adapter,
 * PSP webhook, cashier) and this consumer.
 *
 * There is NO database polling. A producer emits a reconcile event the moment an intent needs
 * attention; the long-lived consumer ({@link runReconcileListener}) blocks on the Redis Stream
 * and reacts immediately. Each event names ONE journaled intent by its deterministic
 * `operatorTransactionId`; the consumer CLAIMS that single row with `FOR UPDATE SKIP LOCKED`
 * (so peers never double-process it) and drives it to a terminal state.
 *
 * The failure modes:
 *   - A BET succeeds but its WIN settlement fails → retry the win with the same key; if the
 *     win is terminally rejected, COMPENSATE by rolling back the bet's
 *     `ledger_transaction_id` so the player isn't left debited for an unpaid spin.
 *   - A DEPOSIT whose PSP capture is confirmed but whose ledger credit failed → retry the
 *     credit with the same key (idempotent; never re-charges).
 *   - A DEPOSIT still PENDING past its deadline → a SCHEDULED backstop event fires and we
 *     poll the PSP directly: credit if it actually succeeded, abandon if it failed, else
 *     reschedule.
 *
 * Every replay reuses the STABLE operatorTransactionId, so the engine de-duplicates
 * (CACHED / GHOST_RECOVERED) and funds are never moved twice. Every payload is STRICTLY
 * re-validated (Zod) before replay. Anything that terminally fails is parked in the DLQ for
 * admin review — never silently dropped (zero transaction loss).
 */

export interface ReconcileOptions {
  /** Give up (ABANDONED → DLQ) after this many engine attempts. */
  maxAttempts?: number;
}

export type Disposition = "succeeded" | "compensated" | "abandoned" | "stillFailing";
/** {@link reconcileByKey} also returns `skipped` when the row is absent/terminal/locked. */
export type ReconcileOutcome = Disposition | "skipped";

/**
 * Reconcile exactly ONE intent, named by its deterministic key. Claims the row under
 * READ COMMITTED + `FOR UPDATE SKIP LOCKED` (incrementing its attempt counter atomically),
 * then drives it through the saga. Returns `skipped` when there is nothing actionable to do
 * (already terminal, missing, over budget, or currently held by a peer consumer).
 */
export async function reconcileByKey(
  operatorTransactionId: string,
  opts: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const maxAttempts = opts.maxAttempts ?? getEnv().RECONCILE_MAX_ATTEMPTS;

  const claim = await claimEngineRequest(operatorTransactionId, maxAttempts);
  if (!claim) return "skipped";
  const { row, attempts } = claim;

  const rowLog = childLogger({
    component: "reconciler",
    operator_transaction_id: row.operatorTransactionId,
    type: row.type,
    player_id: row.playerId ?? undefined,
    provider_ref: row.providerRef ?? undefined,
    attempt: attempts,
  });

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

export interface ListenerOptions extends ReconcileOptions {
  /** Broker override (tests inject a fake). Defaults to the fail-closed Redis broker. */
  queue?: ReconcileQueue;
  /** Max messages pulled per cycle. */
  batchSize?: number;
  /** How long to block for new events per cycle (0 = non-blocking, useful in tests). */
  blockMs?: number;
  /** Min idle before an in-flight message left by a crashed consumer is reclaimed. */
  reclaimIdleMs?: number;
  /** Per-message redelivery budget before a poison message is dead-lettered. */
  maxDeliveries?: number;
  /** Backoff before a still-failing intent's next scheduled attempt. */
  retryDelayMs?: number;
  /** Cooperative stop flag for {@link runReconcileListener}. */
  signal?: { aborted: boolean };
}

/**
 * Handle ONE delivered message: reconcile its intent, then settle the message against the
 * broker. The disposition decides the message's fate:
 *   - succeeded / compensated / skipped → ACK (work is done).
 *   - stillFailing                      → SCHEDULE a delayed re-attempt, then ACK this
 *     delivery (no tight requeue loop).
 *   - abandoned                         → DEAD-LETTER (terminal failure parked for review).
 * A thrown (infra/poison) error leaves the message UNACKED so it is reclaimed and
 * redelivered — unless it has blown its delivery budget, in which case it is dead-lettered
 * so it can never wedge the consumer.
 */
export async function handleReconcileMessage(
  queue: ReconcileQueue,
  msg: ReconcileMessage,
  opts: ListenerOptions = {},
): Promise<ReconcileOutcome> {
  const env = getEnv();
  const maxDeliveries = opts.maxDeliveries ?? env.RECONCILE_MAX_DELIVERIES;
  const retryDelayMs = opts.retryDelayMs ?? env.RECONCILE_STALE_AFTER_MS;
  const msgLog = childLogger({
    component: "reconciler",
    operator_transaction_id: msg.operatorTransactionId,
    delivery_id: msg.deliveryId,
    delivery_count: msg.deliveryCount,
  });

  try {
    const outcome = await reconcileByKey(msg.operatorTransactionId, opts);
    switch (outcome) {
      case "succeeded":
      case "compensated":
      case "skipped":
        await queue.ack(msg);
        break;
      case "stillFailing":
        await queue.schedule(
          { operatorTransactionId: msg.operatorTransactionId, reason: `retry:${msg.reason}` },
          retryDelayMs,
        );
        await queue.ack(msg);
        break;
      case "abandoned":
        await queue.deadLetter(msg, `intent abandoned after reconciliation: ${msg.operatorTransactionId}`);
        msgLog.error({ alert: "reconcile_dead_letter" }, "intent abandoned — parked in DLQ for admin review");
        break;
    }
    return outcome;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "handler error";
    if (msg.deliveryCount >= maxDeliveries) {
      await queue.deadLetter(msg, `poison message (${msg.deliveryCount} deliveries): ${reason}`);
      msgLog.fatal({ alert: "reconcile_poison_dead_letter", err }, "CRITICAL: poison reconcile message parked in DLQ");
      return "abandoned";
    }
    msgLog.error({ err }, "reconcile handler failed; leaving message unacked for redelivery");
    return "stillFailing";
  }
}

/**
 * Run ONE consume cycle: reclaim crashed in-flight messages, then block for fresh events and
 * handle them. Exposed for the worker loop and for tests (no infinite loop).
 */
export async function processReconcileBatch(opts: ListenerOptions = {}): Promise<ReconcileOutcome[]> {
  const env = getEnv();
  const queue = opts.queue ?? getReconcileQueue();
  const batchSize = opts.batchSize ?? env.RECONCILE_BATCH_SIZE;
  const blockMs = opts.blockMs ?? env.RECONCILE_STREAM_BLOCK_MS;
  const reclaimIdleMs = opts.reclaimIdleMs ?? env.RECONCILE_RECLAIM_IDLE_MS;

  const reclaimed = await queue.reclaim(reclaimIdleMs, batchSize);
  const fresh = await queue.pull(batchSize, blockMs);

  const outcomes: ReconcileOutcome[] = [];
  for (const msg of [...reclaimed, ...fresh]) {
    outcomes.push(await handleReconcileMessage(queue, msg, { ...opts, queue }));
  }
  return outcomes;
}

/**
 * Long-lived event loop. Blocks on the broker via {@link processReconcileBatch} until
 * `opts.signal.aborted` flips true. This is the ONLY reconciliation entry point in
 * production — there is no interval and no DB scan.
 */
export async function runReconcileListener(opts: ListenerOptions = {}): Promise<void> {
  const queue = opts.queue ?? getReconcileQueue();
  const listenerLog = childLogger({ component: "reconciler" });
  listenerLog.info("event-driven reconciler listening on the broker");

  const isAborted = (): boolean => opts.signal?.aborted ?? false;
  while (!isAborted()) {
    try {
      await processReconcileBatch({ ...opts, queue });
    } catch (err) {
      listenerLog.error({ err }, "reconcile batch failed; continuing");
    }
  }
  listenerLog.info("reconciler listener stopped");
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

  // STRICT-validate the JSONB payload before ANY replay logic runs. A corrupted row is a
  // runtime crash (or a malformed ledger call) waiting to happen → abandon it and raise a
  // critical alert instead of trusting `Prisma.JsonValue`.
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
    await getPrisma().engineRequestLog.update({ where: { id: row.id }, data: { lastError: note } });
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

  const bet = await getPrisma().engineRequestLog.findUnique({
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
  await getPrisma().engineRequestLog.update({ where: { id }, data: { status, lastError: note } });
}

async function markFailed(id: string, retryable: boolean, note: string): Promise<void> {
  await getPrisma().engineRequestLog.update({
    where: { id },
    data: { status: "FAILED", retryable, lastError: note },
  });
}
