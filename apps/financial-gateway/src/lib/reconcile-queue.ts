import type { Redis } from "ioredis";

import { log } from "./logger";
import { getRedis } from "./redis";

/**
 * Event broker for reconciliation (Phase 5).
 *
 * The legacy reconciler discovered work by POLLING Postgres (`findMany` on an interval).
 * That is forbidden: it hammers the primary, scales poorly, and couples recovery to a cron
 * cadence. Instead, reconciliation is now EVENT-DRIVEN. Producers (the spin adapter, the PSP
 * webhook handler, the cashier) emit an event the instant an intent needs attention; a
 * long-lived consumer BLOCKS on the broker (`XREADGROUP … BLOCK`) and reacts immediately.
 *
 * Backed by Redis Streams + consumer groups:
 *   - {@link STREAM}   — the work stream. `XADD` to enqueue, `XREADGROUP` to consume, `XACK`
 *     to mark done. Unacked entries stay in the group's PEL and are reclaimed (`XAUTOCLAIM`)
 *     if a consumer crashes mid-flight — so an in-flight event is never lost.
 *   - {@link SCHEDULE} — a sorted set acting as a DELAYED queue (score = visible-at ms). It
 *     is the lost-webhook backstop: when a deposit is opened we schedule a reconcile event a
 *     few minutes out, draining due entries into the stream WITHOUT ever scanning Postgres.
 *   - {@link DLQ}      — the Dead Letter Queue. An intent that terminally fails (or a poison
 *     message redelivered past its budget) is parked here for manual/admin review, so a
 *     stuck transaction is quarantined, never silently dropped. Zero transaction loss.
 *
 * FAIL CLOSED (Phase 4 contract): the broker requires Redis. {@link getReconcileQueue} throws
 * {@link ReconcileQueueUnavailableError} when Redis is unconfigured — there is no in-memory
 * fallback. Producers treat a publish failure as best-effort (the durable journal row remains
 * and can be recovered), but the consumer cannot run at all without the broker.
 */

export const STREAM = "reconcile:events";
export const GROUP = "reconcilers";
export const SCHEDULE = "reconcile:scheduled";
export const DLQ = "reconcile:dlq";

export class ReconcileQueueUnavailableError extends Error {
  constructor(message = "reconcile event broker unavailable (REDIS_URL required)") {
    super(message);
    this.name = "ReconcileQueueUnavailableError";
  }
}

/** A reconcile request: WHICH journaled intent to re-drive, and why. */
export interface ReconcileEventInput {
  operatorTransactionId: string;
  reason: string;
}

/** A delivered message, carrying the broker delivery id + redelivery count for poison detection. */
export interface ReconcileMessage {
  /** Stream entry id — the handle used to {@link ReconcileQueue.ack}/{@link ReconcileQueue.deadLetter}. */
  deliveryId: string;
  operatorTransactionId: string;
  reason: string;
  /** How many times this entry has been delivered (1 on first read; >1 after a reclaim). */
  deliveryCount: number;
  enqueuedAt: string;
}

export interface ReconcileQueue {
  /** Enqueue for immediate processing. */
  publish(evt: ReconcileEventInput): Promise<void>;
  /** Enqueue to become visible only after `delayMs` (the lost-webhook deadline backstop). */
  schedule(evt: ReconcileEventInput, delayMs: number): Promise<void>;
  /**
   * Cancel a not-yet-due scheduled backstop for `operatorTransactionId` (no-op if absent).
   * Called the instant an intent settles on its own (e.g. the PSP webhook lands) so its
   * 10-minute backstop never fires a redundant reconcile. Safe to over-call: a backstop that
   * slips through anyway is a harmless no-op (the consumer claims nothing actionable and acks).
   */
  unschedule(operatorTransactionId: string): Promise<void>;
  /**
   * Drain any now-due scheduled events into the stream, then block up to `blockMs` for up to
   * `count` messages. Returns freshly delivered messages (added to the group PEL until acked).
   */
  pull(count: number, blockMs: number): Promise<ReconcileMessage[]>;
  /** Reclaim messages left unacked by a crashed consumer for at least `minIdleMs`. */
  reclaim(minIdleMs: number, count: number): Promise<ReconcileMessage[]>;
  /** Acknowledge successful handling: remove from the PEL and trim the entry. */
  ack(msg: ReconcileMessage): Promise<void>;
  /** Park a poison/terminal message in the DLQ for admin review, then ack it off the stream. */
  deadLetter(msg: ReconcileMessage, error: string): Promise<void>;
}

// ── Redis Streams implementation ───────────────────────────────────────────────

/**
 * The exact subset of stream/sorted-set commands we use. Casting the ioredis client to this
 * keeps every call fully typed (no `any`) without wrestling ioredis's command overloads, and
 * documents precisely which primitives the broker depends on.
 */
interface StreamCommands {
  xadd(...args: Array<string | number>): Promise<string | null>;
  xgroup(...args: Array<string | number>): Promise<unknown>;
  xreadgroup(...args: Array<string | number>): Promise<unknown>;
  xack(...args: Array<string>): Promise<number>;
  xdel(...args: Array<string>): Promise<number>;
  xautoclaim(...args: Array<string | number>): Promise<unknown>;
  xpending(...args: Array<string | number>): Promise<unknown>;
  zadd(...args: Array<string | number>): Promise<unknown>;
  zrangebyscore(...args: Array<string | number>): Promise<string[]>;
  zrem(...args: Array<string>): Promise<number>;
}

type StreamEntry = [id: string, fields: string[]];

export class RedisStreamReconcileQueue implements ReconcileQueue {
  private readonly cmd: StreamCommands;
  private groupEnsured = false;

  constructor(
    redis: Redis,
    private readonly consumerName: string = `reconciler-${process.pid}`,
  ) {
    this.cmd = redis as unknown as StreamCommands;
  }

  /** Lazily create the consumer group (idempotent; ignores BUSYGROUP if it already exists). */
  private async ensureGroup(): Promise<void> {
    if (this.groupEnsured) return;
    try {
      await this.cmd.xgroup("CREATE", STREAM, GROUP, "$", "MKSTREAM");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("BUSYGROUP")) throw err;
    }
    this.groupEnsured = true;
  }

  async publish(evt: ReconcileEventInput): Promise<void> {
    await this.ensureGroup();
    await this.xadd(evt);
  }

  async schedule(evt: ReconcileEventInput, delayMs: number): Promise<void> {
    // The member is the bare operatorTransactionId (NOT a JSON blob), so the backstop is
    // cancellable by id via {@link unschedule} and a re-schedule for the same intent collapses
    // (ZADD updates the score) instead of accumulating duplicate due events. The score is an
    // ABSOLUTE UTC epoch-ms deadline — a strict UTC timestamp, immune to per-host wall-clock
    // formatting — so producers and the draining consumer compare in one clock domain even on
    // different instances (the task's clock-skew constraint). `reason` is diagnostic-only and is
    // re-derived on drain.
    const visibleAt = Date.now() + Math.max(0, delayMs);
    await this.cmd.zadd(SCHEDULE, visibleAt, evt.operatorTransactionId);
  }

  async unschedule(operatorTransactionId: string): Promise<void> {
    await this.cmd.zrem(SCHEDULE, operatorTransactionId);
  }

  async pull(count: number, blockMs: number): Promise<ReconcileMessage[]> {
    await this.ensureGroup();
    await this.drainDueScheduled(count);

    const res = (await this.cmd.xreadgroup(
      "GROUP",
      GROUP,
      this.consumerName,
      "COUNT",
      count,
      "BLOCK",
      blockMs,
      "STREAMS",
      STREAM,
      ">",
    )) as Array<[stream: string, entries: StreamEntry[]]> | null;

    if (!res || res.length === 0) return [];
    const entries = res[0]?.[1] ?? [];
    return entries.map(([id, fields]) => this.toMessage(id, fields, 1));
  }

  async reclaim(minIdleMs: number, count: number): Promise<ReconcileMessage[]> {
    await this.ensureGroup();
    // XAUTOCLAIM (Redis 6.2+): atomically transfer ownership of entries idle > minIdleMs.
    const res = (await this.cmd.xautoclaim(STREAM, GROUP, this.consumerName, minIdleMs, "0", "COUNT", count)) as [
      cursor: string,
      entries: StreamEntry[],
      deleted: string[],
    ];

    const entries = res?.[1] ?? [];
    const out: ReconcileMessage[] = [];
    for (const [id, fields] of entries) {
      // A reclaimed entry has, by definition, been delivered at least twice.
      out.push(this.toMessage(id, fields, await this.deliveryCount(id)));
    }
    return out;
  }

  async ack(msg: ReconcileMessage): Promise<void> {
    await this.cmd.xack(STREAM, GROUP, msg.deliveryId);
    await this.cmd.xdel(STREAM, msg.deliveryId);
  }

  async deadLetter(msg: ReconcileMessage, error: string): Promise<void> {
    await this.cmd.xadd(
      DLQ,
      "*",
      "operatorTransactionId",
      msg.operatorTransactionId,
      "reason",
      msg.reason,
      "error",
      error,
      "deliveryCount",
      String(msg.deliveryCount),
      "originalId",
      msg.deliveryId,
      "deadLetteredAt",
      new Date().toISOString(),
    );
    await this.ack(msg);
  }

  private async xadd(evt: ReconcileEventInput): Promise<void> {
    await this.cmd.xadd(
      STREAM,
      "*",
      "operatorTransactionId",
      evt.operatorTransactionId,
      "reason",
      evt.reason,
      "enqueuedAt",
      new Date().toISOString(),
    );
  }

  /** Move every scheduled entry whose visible-at has passed into the live stream. */
  private async drainDueScheduled(count: number): Promise<void> {
    const now = Date.now();
    const due = await this.cmd.zrangebyscore(SCHEDULE, "-inf", now, "LIMIT", 0, count);
    for (const operatorTransactionId of due) {
      // ZREM gates the move: only the consumer that actually removes the member republishes
      // it, so concurrent consumers can't double-enqueue the same scheduled event.
      const removed = await this.cmd.zrem(SCHEDULE, operatorTransactionId);
      if (removed !== 1) continue;
      await this.xadd({ operatorTransactionId, reason: "scheduled_backstop_due" });
    }
  }

  private async deliveryCount(id: string): Promise<number> {
    const pending = (await this.cmd.xpending(STREAM, GROUP, "IDLE", 0, id, id, 1)) as Array<
      [id: string, consumer: string, idleMs: number, deliveries: number]
    >;
    return pending?.[0]?.[3] ?? 2;
  }

  private toMessage(id: string, fields: string[], deliveryCount: number): ReconcileMessage {
    const map = fieldsToObject(fields);
    return {
      deliveryId: id,
      operatorTransactionId: map.operatorTransactionId ?? "",
      reason: map.reason ?? "unspecified",
      enqueuedAt: map.enqueuedAt ?? new Date().toISOString(),
      deliveryCount,
    };
  }
}

/** Flat Redis stream field array `[k1,v1,k2,v2,…]` → object. */
function fieldsToObject(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

// ── Factory + dependency-injection seam ──────────────────────────────────────
// `setReconcileQueue` is a DI seam (mirrors setPaymentProvider / setNonceStore), NOT a
// test-only `__reset` state leak: it lets the worker and tests supply an explicit broker.

let injected: ReconcileQueue | null = null;

export function setReconcileQueue(queue: ReconcileQueue | null): void {
  injected = queue;
}

/** Resolve the active broker. FAIL CLOSED: throws when neither an override nor Redis exists. */
export function getReconcileQueue(): ReconcileQueue {
  if (injected) return injected;
  const redis = getRedis();
  if (!redis) throw new ReconcileQueueUnavailableError();
  return new RedisStreamReconcileQueue(redis);
}

/**
 * BEST-EFFORT enqueue for request-path PRODUCERS (spin adapter, PSP webhook). Emitting the
 * event is what triggers reconciliation, but the intent has ALREADY been durably journaled
 * (FAILED/PENDING) before this is called — so a broker hiccup only delays recovery, it never
 * loses the transaction. We therefore log-and-swallow rather than failing the caller. The
 * consumer's reclaim/backstop paths still pick the row up. Returns whether the enqueue stuck.
 */
export async function enqueueReconcile(evt: ReconcileEventInput): Promise<boolean> {
  try {
    await getReconcileQueue().publish(evt);
    return true;
  } catch (err) {
    log().error(
      { err, operator_transaction_id: evt.operatorTransactionId },
      "failed to enqueue reconcile event (journal row remains durable)",
    );
    return false;
  }
}

/** BEST-EFFORT delayed enqueue — the deposit lost-webhook backstop (see {@link enqueueReconcile}). */
export async function scheduleReconcile(evt: ReconcileEventInput, delayMs: number): Promise<boolean> {
  try {
    await getReconcileQueue().schedule(evt, delayMs);
    return true;
  } catch (err) {
    log().error(
      { err, operator_transaction_id: evt.operatorTransactionId },
      "failed to schedule reconcile backstop (journal row remains durable)",
    );
    return false;
  }
}

/**
 * BEST-EFFORT cancellation of a deposit's lost-webhook backstop once the intent settles on its
 * own. This is a pure OPTIMIZATION (it suppresses a redundant ~10-min-later reconcile no-op for
 * every successfully settled deposit), so a broker hiccup is swallowed: if the backstop slips
 * through it costs one harmless skipped-then-acked event, never correctness. Returns whether the
 * cancel stuck.
 */
export async function cancelScheduledReconcile(operatorTransactionId: string): Promise<boolean> {
  try {
    await getReconcileQueue().unschedule(operatorTransactionId);
    return true;
  } catch (err) {
    log().error(
      { err, operator_transaction_id: operatorTransactionId },
      "failed to cancel reconcile backstop (stale event will harmlessly no-op)",
    );
    return false;
  }
}
