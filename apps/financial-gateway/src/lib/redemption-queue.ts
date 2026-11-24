import type { Redis } from "ioredis";

import { log } from "./logger";
import { DLQ, RedisStreamQueue, type ReconcileQueue, type StreamKeys } from "./reconcile-queue";
import { getRedis } from "./redis";

/**
 * Event broker for the redemption lifecycle — the SAME machinery as reconcile, pointed at its
 * own stream.
 *
 * Nothing here re-implements consumer groups, reclaim or dead-lettering: RedisStreamQueue is
 * instantiated with a different key set. Two hand-maintained copies of that logic would drift,
 * and drift in a money broker means a lost or double-processed event, which is the one class
 * of bug the broker exists to prevent.
 *
 * WHY A SEPARATE STREAM AND GROUP, BUT A SHARED DLQ
 *   Separate stream: redemption work and reconciliation work have different consumers and
 *   different failure semantics, and a shared stream would make one queue's backlog the
 *   other's latency.
 *   Shared DLQ: an operator should have ONE place to look for stuck work. Quarantined entries
 *   carry the id that produced them, so the existing admin DLQ surface keeps working and
 *   simply has more to show.
 *
 * THE ID FIELD. The generic message carries `operatorTransactionId`; on this stream that slot
 * holds the REDEMPTION REQUEST ID. The wire field is not renamed because renaming it would
 * fork the implementation for no gain — {@link toRedemptionMessage} maps it to a name that
 * reads correctly at the call site, and this note exists so nobody has to guess.
 */

export const REDEMPTION_STREAM = "redemption:events";
export const REDEMPTION_GROUP = "redemption-workers";
export const REDEMPTION_SCHEDULE = "redemption:scheduled";

export const REDEMPTION_KEYS: StreamKeys = {
  stream: REDEMPTION_STREAM,
  group: REDEMPTION_GROUP,
  schedule: REDEMPTION_SCHEDULE,
  // Deliberately the reconcile DLQ — see above.
  dlq: DLQ,
};

export class RedemptionQueueUnavailableError extends Error {
  constructor(message = "redemption event broker unavailable (REDIS_URL required)") {
    super(message);
    this.name = "RedemptionQueueUnavailableError";
  }
}

/** A redemption ready for the worker to advance. */
export interface RedemptionEventInput {
  redemptionId: string;
  reason: string;
}

/** A delivered redemption message, with the id field named for what it actually holds. */
export interface RedemptionMessage {
  deliveryId: string;
  redemptionId: string;
  reason: string;
  deliveryCount: number;
  enqueuedAt: string;
}

export function toRedemptionMessage(msg: {
  deliveryId: string;
  operatorTransactionId: string;
  reason: string;
  deliveryCount: number;
  enqueuedAt: string;
}): RedemptionMessage {
  return {
    deliveryId: msg.deliveryId,
    redemptionId: msg.operatorTransactionId,
    reason: msg.reason,
    deliveryCount: msg.deliveryCount,
    enqueuedAt: msg.enqueuedAt,
  };
}

export class RedisStreamRedemptionQueue extends RedisStreamQueue {
  constructor(redis: Redis, consumerName: string = `redemption-${process.pid}`) {
    super(redis, consumerName, REDEMPTION_KEYS);
  }
}

// ── Factory + DI seam (mirrors setReconcileQueue) ────────────────────────────

let injected: ReconcileQueue | null = null;

export function setRedemptionQueue(queue: ReconcileQueue | null): void {
  injected = queue;
}

/** FAIL CLOSED: no in-memory fallback. A payout pipeline with no broker does not run. */
export function getRedemptionQueue(): ReconcileQueue {
  if (injected) return injected;
  const redis = getRedis();
  if (!redis) throw new RedemptionQueueUnavailableError();
  return new RedisStreamRedemptionQueue(redis);
}

/**
 * BEST-EFFORT enqueue for request-path producers, exactly as enqueueReconcile is: the
 * RedemptionRequest row is already durable before this is called, so a broker hiccup delays
 * the payout pipeline rather than losing it. Returns whether the enqueue stuck.
 */
export async function enqueueRedemption(evt: RedemptionEventInput): Promise<boolean> {
  try {
    await getRedemptionQueue().publish({ operatorTransactionId: evt.redemptionId, reason: evt.reason });
    return true;
  } catch (err) {
    log().error({ err, redemption_id: evt.redemptionId }, "failed to enqueue redemption event (row remains durable)");
    return false;
  }
}
