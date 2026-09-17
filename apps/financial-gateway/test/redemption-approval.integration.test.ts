import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";
import { signAdminToken } from "../src/lib/jwt";
import { MockPayoutProvider, setPayoutProvider } from "../src/lib/payouts";
import { setRedemptionQueue } from "../src/lib/redemption-queue";
import { RedisStreamQueue } from "../src/lib/reconcile-queue";
import { processRedemptionBatch } from "../src/services/redemption-worker.service";
import { testStreamKeys } from "./fakes/redis-keys";
import { getRedemptions, resetDb, seedRedemption } from "./fakes/prisma.fake";

/**
 * B6 — the closed loop, end to end: an operator approves a redemption over HTTP, the message
 * lands on a real Redis Stream, the worker picks it up, and the payout rail is invoked.
 *
 * Every layer here is the real one except the database and the rail itself. In particular the
 * BROKER is real: the whole point of this file is that the admin route and the worker actually
 * meet, and a fake queue shared between them would prove only that two mocks agree.
 */

/** This file's private keyspace — see testStreamKeys. */
const KEYS = testStreamKeys("approval");

const ADMIN_SECRET = "test-admin-jwt-secret-0123456789";
const ADMIN_SUB = "operator-jane";
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const PLAYER_ID = "engine-player-approval";

let app: FastifyInstance;
let redis: Redis;
let available = false;
let payouts: MockPayoutProvider;
let queue: RedisStreamQueue;

beforeAll(async () => {
  process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
  resetEnvCacheForTests();
  app = await buildApp();
  await app.ready();

  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await redis.connect();
    await redis.ping();
    available = true;
  } catch (err) {
    if (process.env.REDIS_TEST_URL) {
      throw new Error(`REDIS_TEST_URL=${process.env.REDIS_TEST_URL} is set but unreachable: ${String(err)}`);
    }
    available = false;
  }
});

afterAll(async () => {
  delete process.env.ADMIN_JWT_SECRET;
  resetEnvCacheForTests();
  setRedemptionQueue(null);
  setPayoutProvider(null);
  await app.close();
  if (redis) await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  resetDb();
  payouts = new MockPayoutProvider();
  setPayoutProvider(payouts);
  if (!available) return;
  await redis.del(KEYS.stream, KEYS.dlq, KEYS.schedule);
  queue = new RedisStreamQueue(redis, "approval-test", KEYS);
  setRedemptionQueue(queue);
});

afterEach(async () => {
  setRedemptionQueue(null);
  setPayoutProvider(null);
  if (!available) return;
  await redis.del(KEYS.stream, KEYS.dlq, KEYS.schedule);
});

const bearer = () => ({ authorization: `Bearer ${signAdminToken({ sub: ADMIN_SUB })}` });

/** A redemption sitting where the route leaves it: debited, awaiting review. */
function underReview(id: string, amount = "500.0000") {
  seedRedemption({
    id,
    userId: USER_ID,
    playerId: PLAYER_ID,
    amount,
    status: "UNDER_REVIEW",
    ledgerTransactionId: `ltx-${id}`,
    operatorTransactionId: `redeem:${id}`,
  });
  return id;
}

function approve(id: string, body: unknown = {}) {
  return app.inject({ method: "POST", url: `/api/admin/redemptions/${id}/approve`, headers: bearer(), payload: body as object });
}

function reject(id: string, body: unknown) {
  return app.inject({ method: "POST", url: `/api/admin/redemptions/${id}/reject`, headers: bearer(), payload: body as object });
}

describe("admin redemption review — auth boundary", () => {
  it("→ 401 without a token, and nothing is enqueued", async () => {
    if (!available) return;
    const id = underReview("appr-auth-1");
    const res = await app.inject({ method: "POST", url: `/api/admin/redemptions/${id}/approve`, payload: {} });

    expect(res.statusCode).toBe(401);
    expect(getRedemptions()[0]?.status).toBe("UNDER_REVIEW");
    expect(await redis.exists(KEYS.stream)).toBe(0);
  });

  it("→ 403 for a cryptographically valid token WITHOUT the admin role", async () => {
    if (!available) return;
    const id = underReview("appr-auth-2");
    const jwtLib = (await import("jsonwebtoken")).default;
    const notAdmin = jwtLib.sign({ sub: "someone", role: "player" }, ADMIN_SECRET, { algorithm: "HS256" });

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/redemptions/${id}/approve`,
      headers: { authorization: `Bearer ${notAdmin}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(getRedemptions()[0]?.status).toBe("UNDER_REVIEW");
  });
});

describe("POST /approve — the producer", () => {
  it("approves, records the actor, and ENQUEUES the message the worker consumes", async () => {
    if (!available) return;
    const id = underReview("appr-1");

    const res = await approve(id, { decisionReason: "KYC cleared, AML check passed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id, status: "APPROVED", reviewedBy: ADMIN_SUB });

    const row = getRedemptions()[0]!;
    expect(row.status).toBe("APPROVED");
    expect(row.reviewedBy).toBe(ADMIN_SUB); // attributable
    expect(row.reviewedAt).toBeTruthy();
    expect(row.decisionReason).toBe("KYC cleared, AML check passed");

    // The message is really on the stream — not merely "the service was called".
    const entries = (await redis.xrange(KEYS.stream, "-", "+")) as Array<[string, string[]]>;
    expect(entries).toHaveLength(1);
    expect(entries[0]![1]).toContain(id);
  });

  it("CLOSES THE LOOP: approval → stream → worker → rail → PAID", async () => {
    if (!available) return;
    const id = underReview("appr-loop-1", "750.0000");

    expect((await approve(id)).statusCode).toBe(200);
    const outcomes = await processRedemptionBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["advanced"]);
    const row = getRedemptions()[0]!;
    expect(row.status).toBe("PAID");
    expect(row.payoutProviderRef).toMatch(/^payout_/);
    expect(row.reviewedBy).toBe(ADMIN_SUB); // the reviewer survives the payout

    // THE NO-FLOAT LAW, end to end: the amount the operator approved is the byte-identical
    // string the rail was handed.
    const snap = await payouts.retrievePayout(id);
    expect(snap?.amount).toBe("750.0000");
    expect(typeof snap?.amount).toBe("string");
  });

  it("is a compare-and-set: two operators approving at once produce ONE approval", async () => {
    if (!available) return;
    const id = underReview("appr-race-1");

    const [a, b] = await Promise.all([approve(id), approve(id)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    // And exactly one payout event, so the worker cannot pay twice.
    const entries = (await redis.xrange(KEYS.stream, "-", "+")) as Array<[string, string[]]>;
    expect(entries).toHaveLength(1);
  });

  it.each(["REQUESTED", "APPROVED", "PROCESSING", "PAID", "REJECTED", "CANCELLED_BY_PLAYER"])(
    "→ 409 for a %s redemption (only UNDER_REVIEW is reviewable)",
    async (status) => {
      if (!available) return;
      seedRedemption({ id: `appr-${status}`, userId: USER_ID, playerId: PLAYER_ID, amount: "100.0000", status });

      const res = await approve(`appr-${status}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("NOT_REVIEWABLE");
      expect(getRedemptions()[0]?.status).toBe(status);
      expect(await redis.exists(KEYS.stream)).toBe(0);
    },
  );

  it("→ 404 for an unknown redemption", async () => {
    if (!available) return;
    expect((await approve("no-such-redemption")).statusCode).toBe(404);
  });

  it("FAILS CLOSED and ROLLS BACK when the broker rejects the publish", async () => {
    if (!available) return;
    const id = underReview("appr-broker-down");
    // A broker that accepts the connection but refuses the write — the nastier failure, because
    // the row has already been approved by the time it bites.
    setRedemptionQueue({
      publish: async () => {
        throw new Error("stream unavailable");
      },
      schedule: async () => undefined,
      unschedule: async () => undefined,
      pull: async () => [],
      reclaim: async () => [],
      ack: async () => undefined,
      deadLetter: async () => undefined,
    });

    const res = await approve(id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("QUEUE_UNAVAILABLE");

    // Rolled back: an APPROVED row with no event to drive it is a payout that silently never
    // happens, which is worse than a visible failure the operator can retry.
    expect(getRedemptions()[0]?.status).toBe("UNDER_REVIEW");
  });
});

describe("POST /reject", () => {
  it("rejects with a mandatory reason and enqueues NOTHING", async () => {
    if (!available) return;
    const id = underReview("rej-1");

    const res = await reject(id, { decisionReason: "Source of funds unverified" });
    expect(res.statusCode).toBe(200);

    const row = getRedemptions()[0]!;
    expect(row.status).toBe("REJECTED");
    expect(row.decisionReason).toBe("Source of funds unverified");
    expect(row.reviewedBy).toBe(ADMIN_SUB);
    expect(row.reviewedAt).toBeTruthy();

    // No payout to make, so no event: the worker must never see a rejected redemption.
    expect(await redis.exists(KEYS.stream)).toBe(0);
  });

  it.each([
    ["missing", {}],
    ["empty", { decisionReason: "" }],
    ["whitespace only", { decisionReason: "   " }],
    ["too short", { decisionReason: "no" }],
  ])("→ 422 when decisionReason is %s — a silent rejection is not allowed", async (_label, body) => {
    if (!available) return;
    const id = underReview("rej-reason");

    const res = await reject(id, body);
    expect(res.statusCode).toBe(422);
    expect(getRedemptions()[0]?.status).toBe("UNDER_REVIEW");
  });

  it.each(["REQUESTED", "APPROVED", "PAID", "REJECTED"])("→ 409 for a %s redemption", async (status) => {
    if (!available) return;
    seedRedemption({ id: `rej-${status}`, userId: USER_ID, playerId: PLAYER_ID, amount: "100.0000", status });

    const res = await reject(`rej-${status}`, { decisionReason: "a perfectly good reason" });
    expect(res.statusCode).toBe(409);
    expect(getRedemptions()[0]?.status).toBe(status);
  });
});

describe("approval → payout failure routing", () => {
  it("a TERMINAL rail refusal after approval halts and dead-letters, leaving the reviewer on record", async () => {
    if (!available) return;
    const id = underReview("appr-fail-1");
    payouts.failNext(id, "PAYEE_BLOCKED", false, "payee is blocked by the rail");

    expect((await approve(id)).statusCode).toBe(200);
    const outcomes = await processRedemptionBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["abandoned"]);
    const row = getRedemptions()[0]!;
    expect(row.status).toBe("PROCESSING"); // never REJECTED — money was debited
    expect(row.decisionReason).toContain("PAYEE_BLOCKED");
    expect(row.reviewedBy).toBe(ADMIN_SUB);

    const dlq = (await redis.xrange(KEYS.dlq, "-", "+")) as Array<[string, string[]]>;
    expect(dlq).toHaveLength(1);
  });

  it("a RETRYABLE rail failure after approval does not pay and does not quarantine", async () => {
    if (!available) return;
    const id = underReview("appr-fail-2");
    payouts.failNext(id, "RAIL_5XX", true, "upstream error");

    expect((await approve(id)).statusCode).toBe(200);
    const outcomes = await processRedemptionBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000, maxDeliveries: 5 });

    expect(outcomes).toEqual(["stillFailing"]);
    expect(getRedemptions()[0]?.paidAt).toBeNull();
    expect(await redis.exists(KEYS.dlq)).toBe(0);
  });
});
