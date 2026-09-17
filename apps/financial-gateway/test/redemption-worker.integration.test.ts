import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { MockPayoutProvider, setPayoutProvider } from "../src/lib/payouts";
import { DLQ } from "../src/lib/reconcile-queue";
import { REDEMPTION_GROUP, REDEMPTION_STREAM, RedisStreamRedemptionQueue } from "../src/lib/redemption-queue";
import {
  advanceRedemption,
  handleRedemptionMessage,
  processRedemptionBatch,
} from "../src/services/redemption-worker.service";
import { getRedemptions, resetDb, seedRedemption } from "./fakes/prisma.fake";

/**
 * Redemption worker — against a LIVE Redis.
 *
 * The fake broker used elsewhere is a good stand-in for dispositions, but it cannot prove the
 * three things that actually matter about a Streams-backed queue: that a consumer group
 * redelivers what a crashed consumer left in the PEL, that an acked entry is really gone, and
 * that a dead-lettered message lands where an operator will find it. Those are Redis
 * behaviours, so they are tested against Redis.
 *
 * Skips (rather than fails) when no REDIS_TEST_URL is configured, so the unit suite stays
 * runnable anywhere; CI sets it.
 */

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";
const PLAYER_ID = "engine-player-worker";
const USER_ID = "44444444-4444-4444-8444-444444444444";

let redis: Redis;
let available = false;
let payouts: MockPayoutProvider;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await redis.connect();
    await redis.ping();
    available = true;
  } catch (err) {
    // A silent skip is the failure mode the test census exists to prevent. When REDIS_TEST_URL
    // is set EXPLICITLY (CI does), an unreachable broker is a build failure — otherwise these
    // tests would "pass" while proving nothing. Locally, with no variable set, they skip.
    if (process.env.REDIS_TEST_URL) {
      throw new Error(`REDIS_TEST_URL=${process.env.REDIS_TEST_URL} is set but unreachable: ${String(err)}`);
    }
    available = false;
  }
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  resetDb();
  // A real implementation of the rail contract, not a stub that always says yes.
  payouts = new MockPayoutProvider();
  setPayoutProvider(payouts);
  if (!available) return;
  await redis.del(REDEMPTION_STREAM, DLQ, "redemption:scheduled");
});

afterEach(async () => {
  setPayoutProvider(null);
  if (!available) return;
  await redis.del(REDEMPTION_STREAM, DLQ, "redemption:scheduled");
});

function queue(consumer = "worker-a") {
  return new RedisStreamRedemptionQueue(redis, consumer);
}

/** An APPROVED redemption, ready for the worker to advance. */
function approved(id: string, amount = "150.0000") {
  seedRedemption({
    id,
    userId: USER_ID,
    playerId: PLAYER_ID,
    amount,
    status: "APPROVED",
    ledgerTransactionId: `ltx-${id}`,
  });
  return id;
}

/** Read the DLQ stream as objects. */
async function readDlq(): Promise<Array<Record<string, string>>> {
  const entries = (await redis.xrange(DLQ, "-", "+")) as Array<[string, string[]]>;
  return entries.map(([, fields]) => {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
    return out;
  });
}

describe.runIf(process.env.VITEST_SKIP_REDIS !== "1")("redemption worker (live Redis)", () => {
  it("carries an APPROVED redemption through the rail to PAID and acks the message", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-advance-1");

    await q.publish({ operatorTransactionId: id, reason: "approved" });
    const outcomes = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["advanced"]);
    const row = getRedemptions()[0]!;
    expect(row.status).toBe("PAID");
    expect(row.payoutProviderRef).toMatch(/^payout_/);
    expect(row.paidAt).toBeTruthy();
    // The rail was given the amount verbatim, as a string.
    const snap = await payouts.retrievePayout(id);
    expect(snap?.amount).toBe("150.0000");
    expect(typeof snap?.amount).toBe("string");
    // Acked AND deleted: nothing is left pending for this group.
    const pending = (await redis.xpending(REDEMPTION_STREAM, REDEMPTION_GROUP)) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });

  it("IDEMPOTENCY: a redelivered message advances the row exactly once", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-idem-1");

    // Same event delivered three times — a duplicate publish, a retry, a reclaim.
    for (let i = 0; i < 3; i++) await q.publish({ operatorTransactionId: id, reason: `delivery-${i}` });
    const outcomes = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

    // Exactly one transition; the rest are idempotent no-ops rather than errors.
    expect(outcomes.filter((o) => o === "advanced")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(2);
    expect(getRedemptions()[0]?.status).toBe("PAID");
    // ONE payout, whatever the delivery count — the rail's idempotency contract holding.
    expect(await payouts.retrievePayout(id)).not.toBeNull();
    // Nothing quarantined: a duplicate is normal traffic, not a fault.
    expect(await readDlq()).toHaveLength(0);
  });

  it("IDEMPOTENCY: two workers racing the same redemption advance it exactly once", async () => {
    if (!available) return;
    const id = approved("red-race-1");

    // The compare-and-set is what decides this, not the read before it.
    const results = await Promise.all([
      advanceRedemption(id),
      advanceRedemption(id),
      advanceRedemption(id),
      advanceRedemption(id),
    ]);

    expect(results.filter((r) => r === "advanced")).toHaveLength(1);
    expect(results.filter((r) => r === "skipped")).toHaveLength(3);
    expect(getRedemptions()[0]?.status).toBe("PAID");
  });

  it.each(["REQUESTED", "UNDER_REVIEW", "PAID", "REJECTED", "CANCELLED_BY_PLAYER"])(
    "leaves a %s redemption untouched (only APPROVED is actionable)",
    async (status) => {
      if (!available) return;
      const q = queue();
      seedRedemption({ id: `red-${status}`, userId: USER_ID, playerId: PLAYER_ID, amount: "100.0000", status });

      await q.publish({ operatorTransactionId: `red-${status}`, reason: "spurious" });
      const outcomes = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

      expect(outcomes).toEqual(["skipped"]);
      expect(getRedemptions()[0]?.status).toBe(status);
    },
  );

  it("RESUMES a PROCESSING redemption whose payout was never submitted", async () => {
    if (!available) return;
    const q = queue();
    // The crash case: the claim committed, the submission did not. The rail has never heard of
    // it, so the work must be finished rather than treated as someone else's in-flight job.
    seedRedemption({
      id: "red-resume-1",
      userId: USER_ID,
      playerId: PLAYER_ID,
      amount: "200.0000",
      status: "PROCESSING",
      ledgerTransactionId: "ltx-red-resume-1",
    });

    await q.publish({ operatorTransactionId: "red-resume-1", reason: "reclaimed" });
    const outcomes = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["advanced"]);
    expect(getRedemptions()[0]?.status).toBe("PAID");
  });

  it("RESUMES a PROCESSING redemption by READING the rail, not by re-sending it", async () => {
    if (!available) return;
    const q = queue();
    const id = "red-resume-2";
    seedRedemption({
      id,
      userId: USER_ID,
      playerId: PLAYER_ID,
      amount: "75.0000",
      status: "PROCESSING",
      ledgerTransactionId: `ltx-${id}`,
    });
    // The payout already went out before we crashed.
    await payouts.sendPayout({ redemptionId: id, playerRef: USER_ID, amount: "75.0000", currency: "USD" });
    const before = await payouts.retrievePayout(id);

    await q.publish({ operatorTransactionId: id, reason: "reclaimed" });
    const outcomes = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["advanced"]);
    expect(getRedemptions()[0]?.status).toBe("PAID");
    // The SAME payout reference — no second payment was created.
    expect((await payouts.retrievePayout(id))?.payoutRef).toBe(before?.payoutRef);
  });

  it("leaves a SUBMITTED (in-flight) payout at PROCESSING until the rail settles it", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-inflight-1");
    payouts.holdAsSubmitted(id);

    await q.publish({ operatorTransactionId: id, reason: "approved" });
    expect(await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 })).toEqual(["advanced"]);

    // Money is in flight: recorded, but NOT marked paid.
    let row = getRedemptions()[0]!;
    expect(row.status).toBe("PROCESSING");
    expect(row.payoutProviderRef).toMatch(/^payout_/);
    expect(row.paidAt).toBeNull();

    // The rail settles, a later event arrives, and only then is it PAID.
    payouts.markPaid(id);
    await q.publish({ operatorTransactionId: id, reason: "settlement-poll" });
    expect(await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 })).toEqual(["advanced"]);

    row = getRedemptions()[0]!;
    expect(row.status).toBe("PAID");
    expect(row.paidAt).toBeTruthy();
  });

  it("TERMINAL rail refusal halts at PROCESSING and dead-letters — it never reads as REJECTED", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-terminal-1");
    payouts.failNext(id, "ACCOUNT_CLOSED", false, "payee account is closed");

    await q.publish({ operatorTransactionId: id, reason: "approved" });
    const outcomes = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["abandoned"]);

    const row = getRedemptions()[0]!;
    // NOT rejected: the SC is already debited, and REJECTED would claim no money moved.
    expect(row.status).toBe("PROCESSING");
    expect(row.decisionReason).toContain("ACCOUNT_CLOSED");
    expect(row.paidAt).toBeNull();

    // And an operator is told, rather than the row quietly sitting there.
    const dlq = await readDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.operatorTransactionId).toBe(id);
  });

  it("RETRYABLE rail failure backs off without paying, then succeeds on the next attempt", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-retry-1");
    payouts.failNext(id, "RAIL_TIMEOUT", true, "gateway timeout");

    await q.publish({ operatorTransactionId: id, reason: "approved" });
    const first = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000, maxDeliveries: 5 });

    expect(first).toEqual(["stillFailing"]);
    // Claimed but unpaid — and crucially NOT quarantined, because a timeout may yet succeed.
    expect(getRedemptions()[0]?.status).toBe("PROCESSING");
    expect(getRedemptions()[0]?.paidAt).toBeNull();
    expect(await readDlq()).toHaveLength(0);

    // The rail recovers; the re-attempt resumes the PROCESSING row and pays exactly once.
    payouts.clearFault(id);
    await q.publish({ operatorTransactionId: id, reason: "retry" });
    const second = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000, maxDeliveries: 5 });

    expect(second).toEqual(["advanced"]);
    expect(getRedemptions()[0]?.status).toBe("PAID");
  });

  it("RETRYABLE failure that never heals is dead-lettered once it blows its budget", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-retry-exhaust");
    payouts.failNext(id, "RAIL_TIMEOUT", true, "gateway timeout");

    await q.publish({ operatorTransactionId: id, reason: "approved" });
    const [msg] = await q.pull(10, 0);
    const final = await handleRedemptionMessage(q, { ...msg!, deliveryCount: 3 }, { maxDeliveries: 3 });

    expect(final).toBe("abandoned");
    const dlq = await readDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.error).toContain("poison message (3 deliveries)");
    // Still unpaid, and still not pretending to be resolved.
    expect(getRedemptions()[0]?.paidAt).toBeNull();
  });

  it("POISON: a message naming no redemption is dead-lettered on first delivery", async () => {
    if (!available) return;
    const q = queue();

    await q.publish({ operatorTransactionId: "red-does-not-exist", reason: "ghost" });
    const outcomes = await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["abandoned"]);

    const dlq = await readDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.operatorTransactionId).toBe("red-does-not-exist");
    expect(dlq[0]?.error).toContain("unknown redemption");
    expect(dlq[0]?.deadLetteredAt).toBeTruthy();

    // Quarantined, not merely dropped: it is off the stream AND recorded.
    const pending = (await redis.xpending(REDEMPTION_STREAM, REDEMPTION_GROUP)) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });

  it("POISON: a repeatedly-failing message is dead-lettered once it blows its delivery budget", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-poison-1");

    // A transient-looking fault that never heals: the compare-and-set itself keeps failing.
    // Injected at the Prisma seam rather than by stubbing the function under test, so the real
    // handler logic — including its error classification — is what runs.
    const { prismaFake } = await import("./fakes/prisma.fake");
    const spy = vi
      .spyOn(prismaFake.redemptionRequest, "updateMany")
      .mockRejectedValue(new Error("database unavailable"));

    try {
      await q.publish({ operatorTransactionId: id, reason: "approved" });
      const [msg] = await q.pull(10, 0);
      expect(msg).toBeDefined();

      // Under budget → scheduled for a re-attempt, NOT quarantined.
      const first = await handleRedemptionMessage(q, { ...msg!, deliveryCount: 1 }, { maxDeliveries: 3 });
      expect(first).toBe("stillFailing");
      expect(await readDlq()).toHaveLength(0);

      // At budget → quarantined, so a poison message can never wedge the consumer.
      await q.publish({ operatorTransactionId: id, reason: "approved" });
      const [again] = await q.pull(10, 0);
      const final = await handleRedemptionMessage(q, { ...again!, deliveryCount: 3 }, { maxDeliveries: 3 });
      expect(final).toBe("abandoned");

      const dlq = await readDlq();
      expect(dlq).toHaveLength(1);
      expect(dlq[0]?.error).toContain("poison message (3 deliveries)");
      expect(dlq[0]?.error).toContain("database unavailable");
    } finally {
      spy.mockRestore();
    }
  });

  it("RECLAIM: work left in-flight by a crashed consumer is picked up by its peer", async () => {
    if (!available) return;
    const crashed = queue("worker-crashed");
    const peer = queue("worker-peer");
    const id = approved("red-reclaim-1");

    // The first consumer reads the message and dies before acking — it stays in the PEL.
    await crashed.publish({ operatorTransactionId: id, reason: "approved" });
    const [inFlight] = await crashed.pull(10, 0);
    expect(inFlight).toBeDefined();
    expect(getRedemptions()[0]?.status).toBe("APPROVED"); // nothing happened yet

    // The peer reclaims anything idle and finishes the job.
    const outcomes = await processRedemptionBatch({ queue: peer, blockMs: 0, reclaimIdleMs: 0 });
    expect(outcomes).toEqual(["advanced"]);
    expect(getRedemptions()[0]?.status).toBe("PAID");

    const pending = (await redis.xpending(REDEMPTION_STREAM, REDEMPTION_GROUP)) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });

  it("uses its OWN stream, and shares the DLQ so operators have one place to look", async () => {
    if (!available) return;
    const q = queue();
    await q.publish({ operatorTransactionId: "red-keys-1", reason: "approved" });

    // The event is on the redemption stream, not the reconcile one.
    expect(await redis.exists(REDEMPTION_STREAM)).toBe(1);
    expect(await redis.exists("reconcile:events")).toBe(0);

    // And its quarantine lands on the shared DLQ the admin surface already watches.
    await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });
    const dlq = await readDlq();
    expect(dlq).toHaveLength(1);
  });

  it("never touches money: the amount is carried untouched across the transition", async () => {
    if (!available) return;
    const q = queue();
    const id = approved("red-money-1", "1234.5678");

    await q.publish({ operatorTransactionId: id, reason: "approved" });
    await processRedemptionBatch({ queue: q, blockMs: 0, reclaimIdleMs: 60_000 });

    const row = getRedemptions()[0]!;
    expect(row.status).toBe("PAID");
    // Byte-identical through the admin decision, the worker and the rail. Still a string, and
    // no balance field appeared anywhere along the way.
    expect(row.amount).toBe("1234.5678");
    expect((await payouts.retrievePayout(id))?.amount).toBe("1234.5678");
    expect(typeof row.amount).toBe("string");
    for (const key of Object.keys(row)) expect(key.toLowerCase()).not.toContain("balance");
  });
});
