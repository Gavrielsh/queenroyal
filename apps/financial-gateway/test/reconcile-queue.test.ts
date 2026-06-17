import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DLQ,
  GROUP,
  type ReconcileMessage,
  RedisStreamReconcileQueue,
  SCHEDULE,
  STREAM,
} from "../src/lib/reconcile-queue";

/**
 * UNIT test for the REAL Redis-Streams broker ({@link RedisStreamReconcileQueue}) against a
 * hand-rolled in-memory ioredis double. Every other suite swaps in the high-level
 * {@link ReconcileQueueFake}; this is the ONLY place the literal Redis command wiring — XADD
 * field order, XREADGROUP/XAUTOCLAIM argument shape, the ZSET backstop drain — is exercised, so
 * a typo in a command string is caught here rather than only in production.
 *
 * Covers the Milestone-1 DoD:
 *   - Task 1: a mock-based assertion that `publish` performs the XADD carrying the
 *     operator_transaction_id onto `reconcile:events`.
 *   - Task 2: `schedule`/`unschedule`/drain are the ZADD/ZREM/ZRANGEBYSCORE backstop.
 *   - Task 3: `pull` blocks via XREADGROUP and `reclaim` sweeps via XAUTOCLAIM.
 */

interface RecordedCall {
  cmd: string;
  args: unknown[];
}

interface StreamEntry {
  id: string;
  fields: string[];
}

interface PelEntry {
  fields: string[];
  deliveries: number;
  idleSince: number;
}

/**
 * Minimal in-memory ioredis double: records every command and models just enough
 * stream/consumer-group/sorted-set behavior for the broker's flows to compose (publish→pull,
 * schedule→drain→pull, pull→reclaim→ack). It is deliberately NOT a full Redis — only the
 * subset the broker actually calls.
 */
class FakeRedis {
  readonly calls: RecordedCall[] = [];
  /** Force the next XGROUP CREATE to fail like a pre-existing group (BUSYGROUP). */
  busygroup = false;

  private readonly main: StreamEntry[] = [];
  private readonly dlq: StreamEntry[] = [];
  private readonly pel = new Map<string, PelEntry>();
  private readonly zset = new Map<string, number>();
  private seq = 0;

  private record(cmd: string, args: unknown[]): void {
    this.calls.push({ cmd, args });
  }
  private nextId(): string {
    this.seq += 1;
    return `0-${this.seq}`;
  }

  callsTo(cmd: string): RecordedCall[] {
    return this.calls.filter((c) => c.cmd === cmd);
  }

  async xgroup(...args: Array<string | number>): Promise<string> {
    this.record("xgroup", args);
    if (this.busygroup) {
      this.busygroup = false;
      throw new Error("BUSYGROUP Consumer Group name already exists");
    }
    return "OK";
  }

  async xadd(...args: Array<string | number>): Promise<string> {
    this.record("xadd", args);
    const key = String(args[0]);
    const fields = args.slice(2).map(String); // skip key + the "*" id
    const id = this.nextId();
    if (key === DLQ) this.dlq.push({ id, fields });
    else this.main.push({ id, fields });
    return id;
  }

  async xreadgroup(...args: Array<string | number>): Promise<unknown> {
    this.record("xreadgroup", args);
    if (this.main.length === 0) return null;
    const delivered = this.main.splice(0).map(({ id, fields }): [string, string[]] => {
      this.pel.set(id, { fields, deliveries: 1, idleSince: Date.now() });
      return [id, fields];
    });
    return [[STREAM, delivered]];
  }

  async xack(...args: string[]): Promise<number> {
    this.record("xack", args);
    return this.pel.delete(args[2] ?? "") ? 1 : 0;
  }

  async xdel(...args: string[]): Promise<number> {
    this.record("xdel", args);
    return 1;
  }

  async xautoclaim(...args: Array<string | number>): Promise<unknown> {
    this.record("xautoclaim", args);
    const minIdleMs = Number(args[3]);
    const now = Date.now();
    const claimed: Array<[string, string[]]> = [];
    for (const [id, entry] of this.pel) {
      if (now - entry.idleSince < minIdleMs) continue;
      entry.deliveries += 1;
      entry.idleSince = now;
      claimed.push([id, entry.fields]);
    }
    return ["0-0", claimed, []];
  }

  async xpending(...args: Array<string | number>): Promise<unknown> {
    this.record("xpending", args);
    const id = String(args[4]);
    const entry = this.pel.get(id);
    return entry ? [[id, "consumer", 0, entry.deliveries]] : [];
  }

  async zadd(...args: Array<string | number>): Promise<number> {
    this.record("zadd", args);
    this.zset.set(String(args[2]), Number(args[1]));
    return 1;
  }

  async zrangebyscore(...args: Array<string | number>): Promise<string[]> {
    this.record("zrangebyscore", args);
    const max = args[2] === "+inf" ? Infinity : Number(args[2]);
    const min = args[1] === "-inf" ? -Infinity : Number(args[1]);
    // args: key, min, max, "LIMIT", offset, count
    const offset = Number(args[4] ?? 0);
    const count = Number(args[5] ?? Infinity);
    return [...this.zset.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member)
      .slice(offset, offset + count);
  }

  async zrem(...args: string[]): Promise<number> {
    this.record("zrem", args);
    return this.zset.delete(args[1] ?? "") ? 1 : 0;
  }

  /** Test inspection: members currently parked in the backstop ZSET. */
  scheduledMembers(): string[] {
    return [...this.zset.keys()];
  }
}

function makeQueue(redis: FakeRedis): RedisStreamReconcileQueue {
  return new RedisStreamReconcileQueue(redis as unknown as Redis, "test-consumer");
}

let redis: FakeRedis;
let queue: RedisStreamReconcileQueue;

beforeEach(() => {
  redis = new FakeRedis();
  queue = makeQueue(redis);
});

describe("RedisStreamReconcileQueue — Redis command wiring", () => {
  it("Task 1: publish XADDs the operator_transaction_id onto reconcile:events", async () => {
    await queue.publish({ operatorTransactionId: "bet:abc", reason: "bet_failed_retryable" });

    const xadds = redis.callsTo("xadd");
    expect(xadds).toHaveLength(1);
    // XADD reconcile:events * operatorTransactionId <id> reason <reason> enqueuedAt <iso>
    const args = xadds[0]!.args.map(String);
    expect(args[0]).toBe(STREAM);
    expect(args[1]).toBe("*");
    expect(args).toContain("operatorTransactionId");
    expect(args[args.indexOf("operatorTransactionId") + 1]).toBe("bet:abc");
    expect(args[args.indexOf("reason") + 1]).toBe("bet_failed_retryable");
  });

  it("lazily creates the consumer group once and tolerates BUSYGROUP", async () => {
    redis.busygroup = true; // group already exists on the first CREATE
    await queue.publish({ operatorTransactionId: "bet:a", reason: "r" });
    await queue.publish({ operatorTransactionId: "bet:b", reason: "r" }); // group already ensured

    const creates = redis.callsTo("xgroup");
    expect(creates).toHaveLength(1); // ensured once, not per-publish
    expect(creates[0]!.args.map(String)).toEqual(["CREATE", STREAM, GROUP, "$", "MKSTREAM"]);
  });

  it("Task 2: schedule ZADDs the bare operator_transaction_id with an absolute epoch-ms score", async () => {
    const before = Date.now();
    await queue.schedule({ operatorTransactionId: "deposit:1", reason: "deposit_pending_deadline" }, 600_000);

    const zadds = redis.callsTo("zadd");
    expect(zadds).toHaveLength(1);
    const [key, score, member] = zadds[0]!.args;
    expect(key).toBe(SCHEDULE);
    expect(member).toBe("deposit:1"); // bare id → cancellable, idempotent per intent
    expect(Number(score)).toBeGreaterThanOrEqual(before + 600_000);
  });

  it("Task 2: unschedule ZREMs the backstop by operator_transaction_id", async () => {
    await queue.schedule({ operatorTransactionId: "deposit:1", reason: "deposit_pending_deadline" }, 600_000);
    expect(redis.scheduledMembers()).toEqual(["deposit:1"]);

    await queue.unschedule("deposit:1");

    const zrems = redis.callsTo("zrem");
    expect(zrems).toHaveLength(1);
    expect(zrems[0]!.args).toEqual([SCHEDULE, "deposit:1"]);
    expect(redis.scheduledMembers()).toEqual([]); // backstop dropped
  });

  it("re-scheduling the same intent collapses to one due entry (ZADD updates the score)", async () => {
    await queue.schedule({ operatorTransactionId: "deposit:1", reason: "a" }, 600_000);
    await queue.schedule({ operatorTransactionId: "deposit:1", reason: "b" }, 900_000);
    expect(redis.scheduledMembers()).toEqual(["deposit:1"]); // not duplicated
  });

  it("Task 2→3: pull drains a now-due backstop into the stream, then XREADGROUPs it", async () => {
    await queue.schedule({ operatorTransactionId: "deposit:due", reason: "deposit_pending_deadline" }, 0);

    const msgs = await queue.pull(10, 0);

    // Drain wiring: ZRANGEBYSCORE -inf <now> → ZREM → XADD(republish) → XREADGROUP.
    const range = redis.callsTo("zrangebyscore")[0]!;
    expect(range.args[0]).toBe(SCHEDULE);
    expect(range.args[1]).toBe("-inf");
    expect(redis.callsTo("zrem")).toHaveLength(1); // gated move out of the ZSET
    expect(redis.callsTo("xadd")).toHaveLength(1); // republished onto the stream

    const read = redis.callsTo("xreadgroup")[0]!.args.map(String);
    expect(read.slice(0, 3)).toEqual(["GROUP", GROUP, "test-consumer"]);
    expect(read).toContain("BLOCK");
    expect(read[read.length - 2]).toBe(STREAM);
    expect(read[read.length - 1]).toBe(">"); // only never-delivered entries

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.operatorTransactionId).toBe("deposit:due");
    expect(msgs[0]!.deliveryCount).toBe(1);
  });

  it("Task 3: reclaim sweeps stale in-flight entries via XAUTOCLAIM (deliveryCount > 1)", async () => {
    await queue.publish({ operatorTransactionId: "bet:stuck", reason: "r" });
    const [delivered] = await queue.pull(10, 0); // moves it into the PEL, unacked
    expect(delivered).toBeDefined();

    const reclaimed = await queue.reclaim(0, 10); // minIdle 0 → immediately reclaimable

    const auto = redis.callsTo("xautoclaim")[0]!.args.map(String);
    // XAUTOCLAIM reconcile:events reconcilers test-consumer <minIdle=0> <start-cursor="0"> COUNT <n>
    expect(auto).toEqual([STREAM, GROUP, "test-consumer", "0", "0", "COUNT", "10"]);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.operatorTransactionId).toBe("bet:stuck");
    expect(reclaimed[0]!.deliveryCount).toBeGreaterThan(1); // redelivered after the "crash"
  });

  it("ack XACKs then XDELs the delivery off the stream", async () => {
    await queue.publish({ operatorTransactionId: "bet:ackme", reason: "r" });
    const [msg] = await queue.pull(10, 0);

    await queue.ack(msg as ReconcileMessage);

    expect(redis.callsTo("xack")[0]!.args).toEqual([STREAM, GROUP, msg!.deliveryId]);
    expect(redis.callsTo("xdel")[0]!.args).toEqual([STREAM, msg!.deliveryId]);
    // A second pull finds nothing — it was removed.
    expect(await queue.pull(10, 0)).toHaveLength(0);
  });

  it("deadLetter parks the message on reconcile:dlq with context, then acks it off the stream", async () => {
    await queue.publish({ operatorTransactionId: "bet:poison", reason: "bet_failed_retryable" });
    const [msg] = await queue.pull(10, 0);

    await queue.deadLetter(msg as ReconcileMessage, "exhausted retries");

    const dlqAdd = redis.callsTo("xadd").find((c) => c.args[0] === DLQ)!;
    const fields = dlqAdd.args.map(String);
    expect(fields[1]).toBe("*");
    expect(fields[fields.indexOf("operatorTransactionId") + 1]).toBe("bet:poison");
    expect(fields[fields.indexOf("error") + 1]).toBe("exhausted retries");
    expect(fields[fields.indexOf("originalId") + 1]).toBe(msg!.deliveryId);
    // Parked AND acked: it can never wedge the consumer again.
    expect(redis.callsTo("xack")[0]!.args).toEqual([STREAM, GROUP, msg!.deliveryId]);
  });
});
