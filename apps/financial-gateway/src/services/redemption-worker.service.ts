import { getEnv } from "../config/env";
import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import type { ReconcileMessage, ReconcileQueue } from "../lib/reconcile-queue";
import { getRedemptionQueue, toRedemptionMessage } from "../lib/redemption-queue";

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
 * WHAT IT ADVANCES, AND WHAT IT DOES NOT
 *   APPROVED → PROCESSING is the only transition it makes. Handing the request to a payout
 *   rail, and PROCESSING → PAID, belong to the PayoutProvider that is not built yet — and
 *   wiring a half-present rail in here would mean a worker that looks like it pays people.
 *   Every other status is a no-op, which is exactly what makes redelivery safe.
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
export async function advanceRedemption(redemptionId: string): Promise<RedemptionDisposition> {
  const row = await getPrisma().redemptionRequest.findUnique({ where: { id: redemptionId } });
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

  if (row.status !== "APPROVED") {
    // Already advanced, still awaiting review, or terminal. Nothing to do, and saying so is
    // not a failure — it is the idempotent answer.
    rowLog.debug("redemption not actionable; skipping");
    return "skipped";
  }

  const claimed = await getPrisma().redemptionRequest.updateMany({
    where: { id: redemptionId, status: "APPROVED" },
    data: { status: "PROCESSING", statusChangedAt: new Date() },
  });

  if (claimed.count !== 1) {
    // A peer won the race between the read above and this update. Correct and expected.
    rowLog.debug("redemption claimed by a peer worker; skipping");
    return "skipped";
  }

  rowLog.info("redemption advanced to PROCESSING");
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
