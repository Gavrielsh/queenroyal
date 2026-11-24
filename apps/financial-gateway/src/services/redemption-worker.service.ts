import { getEnv } from "../config/env";
import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import type { ReconcileMessage, ReconcileQueue } from "../lib/reconcile-queue";
import { getPayoutProvider, PayoutProviderError, type PayoutProvider } from "../lib/payouts";
import { getRedemptionQueue, toRedemptionMessage } from "../lib/redemption-queue";
import { refundRedemption } from "./redemption-refund.service";

/**
 * The redemption payout pipeline's consumer — a STATE MACHINE DRIVER and nothing more.
 *
 * It mirrors reconciliation.service's shape deliberately: reclaim crashed in-flight work,
 * block for fresh events, handle each one, settle the message against the broker. Anyone who
 * has read one can read the other, and the two share a single implementation of the stream
 * mechanics underneath (see redemption-queue).
 *
 * ZERO FINANCIAL STATE. The worker moves a row between lifecycle states. It computes no
 * balance, reads none, and performs no arithmetic on money at all — `amount` is carried as the
 * opaque decimal string it has been since B1 and is never summed, compared or converted here.
 * The SC was already debited in Zone 1 at request time; what remains is orchestration.
 *
 * WHAT IT ADVANCES
 *   APPROVED → PROCESSING (a compare-and-set claim), then the payout rail, then
 *   PROCESSING → PAID once the rail settles. Every other status is a no-op, which is exactly
 *   what makes redelivery safe.
 *
 * A TERMINAL PAYOUT FAILURE REFUNDS, AND STILL DOES NOT BECOME "REJECTED"
 *   By the time the rail is called the SC has ALREADY been debited in Zone 1. The player is
 *   now owed it back, so the compensating credit runs — the same one the admin reject route
 *   uses, on the same derived anchor, so the two paths cannot double-credit each other.
 *
 *   The status still does not become REJECTED. REJECTED means "refused by review", and a
 *   refused review implies no money moved; writing it after a debit would be a lie in the one
 *   record an auditor reads. The row stays at PROCESSING with the reason recorded and the
 *   message dead-lettered, because a payout that was attempted and failed is a thing an
 *   operator needs to see even once the player has been made whole.
 */

export type RedemptionDisposition = "advanced" | "skipped" | "stillFailing" | "abandoned";

export interface RedemptionWorkerOptions {
  queue?: ReconcileQueue;
  batchSize?: number;
  blockMs?: number;
  reclaimIdleMs?: number;
  maxDeliveries?: number;
  retryDelayMs?: number;
  signal?: { aborted: boolean };
}

/** Raised for a message that names no redemption — a poison message, not a retryable fault. */
export class UnknownRedemptionError extends Error {
  constructor(public readonly redemptionId: string) {
    super(`no redemption_requests row for id=${redemptionId}`);
    this.name = "UnknownRedemptionError";
  }
}

/**
 * Advance ONE redemption, named by its id.
 *
 * STRICT IDEMPOTENCY, ENFORCED BY THE DATABASE AND NOT BY A READ.
 * The transition is a conditional update — `updateMany` WHERE id = ? AND status = 'APPROVED'
 * — so the status check and the write are ONE atomic statement. A read-then-write would leave
 * a window in which two workers both see APPROVED and both advance it; here exactly one
 * update reports count === 1 and every other caller sees 0 and skips. That makes a duplicate
 * delivery, a reclaimed in-flight message and a genuinely concurrent peer all produce the same
 * outcome: the row advances at most once.
 */
export async function advanceRedemption(
  redemptionId: string,
  provider: PayoutProvider = getPayoutProvider(),
): Promise<RedemptionDisposition> {
  const prisma = getPrisma();
  const row = await prisma.redemptionRequest.findUnique({ where: { id: redemptionId } });
  if (!row) {
    // Not retryable: no amount of waiting makes a row appear. Poison.
    throw new UnknownRedemptionError(redemptionId);
  }

  const rowLog = childLogger({
    component: "redemption-worker",
    redemption_id: redemptionId,
    player_id: row.playerId,
    status: row.status,
  });

  // A redelivery of work already in flight at the rail is resumed, not restarted — that is
  // what makes a crash between "submitted" and "recorded" recoverable.
  if (row.status === "PROCESSING") {
    return resolveInFlightPayout(redemptionId, row, provider, rowLog);
  }

  if (row.status !== "APPROVED") {
    // Still awaiting review, or terminal. Nothing to do, and saying so is not a failure — it is
    // the idempotent answer.
    rowLog.debug("redemption not actionable; skipping");
    return "skipped";
  }

  const claimed = await prisma.redemptionRequest.updateMany({
    where: { id: redemptionId, status: "APPROVED" },
    data: { status: "PROCESSING", statusChangedAt: new Date() },
  });

  if (claimed.count !== 1) {
    // A peer won the race between the read above and this update. Correct and expected.
    rowLog.debug("redemption claimed by a peer worker; skipping");
    return "skipped";
  }

  rowLog.info("redemption claimed for payout (PROCESSING)");
  return dispatchPayout(redemptionId, row, provider, rowLog);
}

/**
 * Submit the payout and record its outcome.
 *
 * The amount travels from the row to the rail as the SAME decimal string it was debited as —
 * never parsed, never reformatted, never summed. There is no arithmetic anywhere in this path.
 */
async function dispatchPayout(
  redemptionId: string,
  row: { playerId: string; userId: string; amount: string },
  provider: PayoutProvider,
  rowLog: ReturnType<typeof childLogger>,
): Promise<RedemptionDisposition> {
  let result;
  try {
    result = await provider.sendPayout({
      redemptionId,
      playerRef: row.userId,
      amount: row.amount,
      currency: "USD",
      metadata: { player_id: row.playerId },
    });
  } catch (err) {
    if (err instanceof PayoutProviderError && !err.retryable) {
      // A definite NO from the rail. Halt, record why, give the money back, and dead-letter
      // the message so an operator still sees that a payout was attempted and failed.
      await getPrisma().redemptionRequest.updateMany({
        where: { id: redemptionId, status: "PROCESSING" },
        data: { decisionReason: `payout rail refused: ${err.code}: ${err.message}` },
      });
      const refund = await refundRedemption(redemptionId, `payout rail refused: ${err.code}`);
      if (!refund.ok) {
        rowLog.fatal(
          { alert: "payout_terminal_failure_unrefunded", err_code: err.code, refund_error: refund.error },
          "CRITICAL: payout refused AND the refund did not land — the player is debited and unpaid",
        );
      } else {
        rowLog.error(
          { alert: "payout_terminal_failure", err_code: err.code, refund_ledger_tx: refund.ledgerTransactionId },
          "payout refused terminally; the SC has been refunded to the player",
        );
      }
      return "abandoned";
    }
    // Retryable, or an unexpected error: rethrow so the message handler backs off and, past its
    // budget, dead-letters it. We do NOT flip the row — the rail may have accepted the payout
    // without us seeing the response, and the next attempt resumes via resolveInFlightPayout.
    throw err;
  }

  return recordPayoutResult(redemptionId, result, rowLog);
}

/**
 * Resume a redemption already at PROCESSING.
 *
 * ASKS THE RAIL BEFORE SENDING. The rail is idempotent on redemptionId, so a second send would
 * be safe — but reading first is cheaper, and more importantly it resolves the case this branch
 * exists for: we crashed after submitting and before recording, so the money may already be in
 * flight. Re-sending blind would be safe; reporting "submitted" for a payout that already
 * settled would not be.
 */
async function resolveInFlightPayout(
  redemptionId: string,
  row: { playerId: string; userId: string; amount: string },
  provider: PayoutProvider,
  rowLog: ReturnType<typeof childLogger>,
): Promise<RedemptionDisposition> {
  const snapshot = await provider.retrievePayout(redemptionId);
  if (!snapshot) {
    // The rail has never seen it: the claim committed but the submission did not. Send it.
    rowLog.info("redemption was claimed but never submitted; dispatching now");
    return dispatchPayout(redemptionId, row, provider, rowLog);
  }
  return recordPayoutResult(redemptionId, snapshot, rowLog);
}

/** Write the rail's answer onto the row. Guarded on PROCESSING so it can never resurrect. */
async function recordPayoutResult(
  redemptionId: string,
  result: { payoutRef: string; status: string; failureReason?: string },
  rowLog: ReturnType<typeof childLogger>,
): Promise<RedemptionDisposition> {
  const prisma = getPrisma();

  if (result.status === "paid") {
    const settled = await prisma.redemptionRequest.updateMany({
      where: { id: redemptionId, status: "PROCESSING" },
      data: {
        status: "PAID",
        statusChangedAt: new Date(),
        paidAt: new Date(),
        payoutProviderRef: result.payoutRef,
      },
    });
    if (settled.count !== 1) {
      // Someone else recorded it first. Idempotent, not an error.
      rowLog.debug({ payout_ref: result.payoutRef }, "payout already recorded by a peer");
      return "skipped";
    }
    rowLog.info({ payout_ref: result.payoutRef }, "redemption PAID");
    return "advanced";
  }

  if (result.status === "failed") {
    await prisma.redemptionRequest.updateMany({
      where: { id: redemptionId, status: "PROCESSING" },
      data: { decisionReason: `payout rail failed: ${result.failureReason ?? "unspecified"}` },
    });
    const refund = await refundRedemption(redemptionId, `payout rail failed: ${result.failureReason ?? "unspecified"}`);
    if (!refund.ok) {
      rowLog.fatal(
        { alert: "payout_terminal_failure_unrefunded", payout_ref: result.payoutRef, refund_error: refund.error },
        "CRITICAL: payout failed AND the refund did not land — the player is debited and unpaid",
      );
    } else {
      rowLog.error(
        { alert: "payout_terminal_failure", payout_ref: result.payoutRef, refund_ledger_tx: refund.ledgerTransactionId },
        "payout failed at the rail; the SC has been refunded to the player",
      );
    }
    return "abandoned";
  }

  // submitted — in flight. Record the reference so a later attempt resolves rather than
  // re-sends, and leave the row at PROCESSING.
  await prisma.redemptionRequest.updateMany({
    where: { id: redemptionId, status: "PROCESSING" },
    data: { payoutProviderRef: result.payoutRef },
  });
  rowLog.info({ payout_ref: result.payoutRef }, "payout submitted; awaiting settlement");
  return "advanced";
}

/**
 * Handle ONE delivered message and settle it against the broker. The disposition decides the
 * message's fate, exactly as it does for reconciliation:
 *   advanced / skipped → ACK (the work is done, or was never needed).
 *   stillFailing       → SCHEDULE a delayed re-attempt, then ACK (no tight requeue loop).
 *   abandoned          → DEAD-LETTER, parked for admin review rather than dropped.
 *
 * A poison message — one naming a redemption that does not exist — is dead-lettered on its
 * FIRST delivery rather than retried to exhaustion: the fault cannot heal, so redelivering it
 * only delays the operator finding out.
 */
export async function handleRedemptionMessage(
  queue: ReconcileQueue,
  raw: ReconcileMessage,
  opts: RedemptionWorkerOptions = {},
): Promise<RedemptionDisposition> {
  const env = getEnv();
  const msg = toRedemptionMessage(raw);
  const maxDeliveries = opts.maxDeliveries ?? env.RECONCILE_MAX_DELIVERIES;
  const retryDelayMs = opts.retryDelayMs ?? env.RECONCILE_STALE_AFTER_MS;
  const msgLog = childLogger({
    component: "redemption-worker",
    redemption_id: msg.redemptionId,
    delivery_id: msg.deliveryId,
    delivery_count: msg.deliveryCount,
  });

  try {
    const disposition = await advanceRedemption(msg.redemptionId);
    if (disposition === "abandoned") {
      // A terminal payout failure. Quarantined so an operator sees it, never silently acked.
      await queue.deadLetter(raw, `payout halted for redemption ${msg.redemptionId}`);
      return disposition;
    }
    await queue.ack(raw);
    return disposition;
  } catch (err) {
    if (err instanceof UnknownRedemptionError) {
      await queue.deadLetter(raw, `unknown redemption: ${msg.redemptionId}`);
      msgLog.error({ alert: "redemption_dead_letter" }, "message names no redemption — parked in DLQ");
      return "abandoned";
    }
    const reason = err instanceof Error ? err.message : "handler error";
    if (msg.deliveryCount >= maxDeliveries) {
      await queue.deadLetter(raw, `poison message (${msg.deliveryCount} deliveries): ${reason}`);
      msgLog.fatal({ alert: "redemption_poison_dead_letter", err }, "CRITICAL: poison redemption message parked in DLQ");
      return "abandoned";
    }
    // Transient (a database blip): re-attempt later rather than burning the delivery budget
    // in a tight loop.
    await queue.schedule({ operatorTransactionId: msg.redemptionId, reason: `retry:${msg.reason}` }, retryDelayMs);
    await queue.ack(raw);
    msgLog.error({ err }, "redemption handler failed; scheduled for re-attempt");
    return "stillFailing";
  }
}

/** Run ONE consume cycle. Exposed for the worker loop and for tests (no infinite loop). */
export async function processRedemptionBatch(opts: RedemptionWorkerOptions = {}): Promise<RedemptionDisposition[]> {
  const env = getEnv();
  const queue = opts.queue ?? getRedemptionQueue();
  const batchSize = opts.batchSize ?? env.RECONCILE_BATCH_SIZE;
  const blockMs = opts.blockMs ?? env.RECONCILE_STREAM_BLOCK_MS;
  const reclaimIdleMs = opts.reclaimIdleMs ?? env.RECONCILE_RECLAIM_IDLE_MS;

  const reclaimed = await queue.reclaim(reclaimIdleMs, batchSize);
  const fresh = await queue.pull(batchSize, blockMs);

  const out: RedemptionDisposition[] = [];
  for (const msg of [...reclaimed, ...fresh]) {
    out.push(await handleRedemptionMessage(queue, msg, { ...opts, queue }));
  }
  return out;
}

/** Long-lived event loop: blocks on the broker until the caller's signal flips. */
export async function runRedemptionListener(opts: RedemptionWorkerOptions = {}): Promise<void> {
  const queue = opts.queue ?? getRedemptionQueue();
  const listenerLog = childLogger({ component: "redemption-worker" });
  listenerLog.info("redemption worker listening on the broker");

  const isAborted = (): boolean => opts.signal?.aborted ?? false;
  while (!isAborted()) {
    try {
      await processRedemptionBatch({ ...opts, queue });
    } catch (err) {
      listenerLog.error({ err }, "redemption batch failed; continuing");
    }
  }
  listenerLog.info("redemption worker stopped");
}
