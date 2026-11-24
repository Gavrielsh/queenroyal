import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { getDailyBonusOffer } from "../src/config/daily-bonus";
import { resetEnvCacheForTests } from "../src/config/env";
import { signAccessToken } from "../src/lib/jwt";
import { RedisStreamQueue, setReconcileQueue } from "../src/lib/reconcile-queue";
import { claimDailyBonus, getDailyBonusStatus } from "../src/services/daily-bonus.service";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { getDailyBonusClaims, getJournal, resetDb, seedDailyBonusClaim, seedUser } from "./fakes/prisma.fake";
import { testStreamKeys } from "./fakes/redis-keys";

/**
 * The Daily Wheel, end to end. What must hold:
 *   - the server draws the slice and the claimant cannot influence it;
 *   - one spin per player per gaming day, including under concurrency;
 *   - a failed dispatch still spends the day; a retryable one is left for the reconciler;
 *   - the grant reaches Zone 1 as a BONUS promo grant with the drawn slice's amounts, verbatim.
 */

const JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";
const PROMO_PATH = "/api/v1/store/promo-grant";
const KEYS = testStreamKeys("daily-bonus");

const USER_ID = "88888888-8888-4888-8888-888888888888";
const PLAYER_ID = "engine-player-bonus";
/** 15:00Z on 2026-09-23 = 11:00 EDT: gaming day 2026-09-23. */
const NOON_ISH = new Date("2026-09-23T15:00:00Z");
const at = (d: Date) => ({ now: () => d });

let app: FastifyInstance;
let redis: Redis;
let available = false;

const promoCalls = () => engineCalls.filter((c) => c.path === PROMO_PATH);

/** De-duplicates on operator_transaction_id, as the real engine does. */
const credited = new Map<string, string>();
function dedupingEngine(): (call: EngineCall) => Directive {
  return (call: EngineCall) => {
    if (call.path !== PROMO_PATH) return { ok: false, status: 500, body: { code: "UNEXPECTED", message: call.path } };
    const body = call.body as Record<string, unknown>;
    const anchor = body.operator_transaction_id as string;
    const seen = credited.has(anchor);
    if (!seen) credited.set(anchor, `ltx-bonus-${credited.size + 1}`);
    return {
      ok: true,
      status: 200,
      body: {
        code: "OK",
        result: {
          operator_code: "TEST_OP",
          operator_transaction_id: anchor,
          ledger_transaction_id: credited.get(anchor),
          player_id: PLAYER_ID,
          transaction_type: "PROMO_CREDIT",
          amount: body.gc_amount,
          post_balances: { gc: "5000", sc_unplayed: "0", sc_redeemable: "0" },
          status: seen ? "CACHED" : "PROCESSED",
        },
      },
    };
  };
}

const claims = (userId = USER_ID) => ({ sub: userId, email: "bonus@example.test", kycStatus: "PENDING", vipLevel: 0 });
const bearer = (userId = USER_ID) => `Bearer ${signAccessToken(claims(userId))}`;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
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
  if (available) process.env.REDIS_URL = REDIS_URL;
  resetEnvCacheForTests();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  setReconcileQueue(null);
  delete process.env.JWT_SECRET;
  delete process.env.REDIS_URL;
  resetEnvCacheForTests();
  await app.close();
  if (redis) await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  resetDb();
  resetEngine();
  credited.clear();
  setEngineHandler(dedupingEngine());
  seedUser({ id: USER_ID, email: "bonus@example.test", kycStatus: "PENDING", trueEnginePlayerId: PLAYER_ID });
  if (!available) {
    setReconcileQueue(null);
    return;
  }
  const keys = await redis.keys("ratelimit:bonus:daily:*");
  if (keys.length > 0) await redis.del(...keys);
  await redis.del(KEYS.stream, KEYS.dlq, KEYS.schedule);
  setReconcileQueue(new RedisStreamQueue(redis, "daily-bonus-test", KEYS));
});

afterEach(() => {
  resetEngine();
  setReconcileQueue(null);
});

describe("the draw and the Zone 1 dispatch", () => {
  it("credits the SERVER-drawn slice as a BONUS promo grant, amounts verbatim", async () => {
    // pick = 18 lands on the second slice (weights 18, 14, …): 0.2 SC.
    const outcome = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0001" }, { jurisdiction: "US-NJ" }, {
      ...at(NOON_ISH),
      pick: () => 18,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toMatchObject({ status: "GRANTED", segmentId: "s2", gcAmount: "0", scAmount: "0.2000" });
    expect(outcome.data.gamingDate).toBe("2026-09-23");
    expect(outcome.data.nextClaimAt).toBe("2026-09-24T04:00:00.000Z");

    const body = promoCalls()[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      channel: "BONUS",
      player_id: PLAYER_ID,
      gc_amount: "0",
      sc_amount: "0.2000",
      operator_transaction_id: `bonus:daily:${outcome.data.claimId}`,
      channel_reference: `BONUS-${outcome.data.claimId}`,
    });
    expect(typeof body.sc_amount).toBe("string");

    const row = getDailyBonusClaims()[0]!;
    expect(row).toMatchObject({ status: "GRANTED", segmentId: "s2", ledgerTransactionId: "ltx-bonus-1" });
    // Zone 2 keeps no balance: nothing from post_balances lands on the row.
    expect(JSON.stringify(row)).not.toContain("sc_unplayed");
  });

  it("journals the PROMO_GRANT intent and closes it as SUCCEEDED", async () => {
    const outcome = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0002" }, {}, at(NOON_ISH));
    if (!outcome.ok) throw new Error("expected a grant");
    const entry = getJournal(`bonus:daily:${outcome.data.claimId}`)!;
    expect(entry.type).toBe("PROMO_GRANT");
    expect(entry.status).toBe("SUCCEEDED");
  });
});

describe("the daily cap", () => {
  it("refuses a second spin on the same gaming day, naming when the next one opens", async () => {
    await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0010" }, {}, at(NOON_ISH));
    const second = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0011" }, {}, at(NOON_ISH));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.error.code).toBe("ALREADY_CLAIMED_TODAY");
    expect(second.error.details).toMatchObject({ nextClaimAt: "2026-09-24T04:00:00.000Z" });
    expect(promoCalls()).toHaveLength(1);
  });

  it("opens a new spin one minute after ET midnight", async () => {
    await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0020" }, {}, at(new Date("2026-09-24T03:59:00Z")));
    const next = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0021" }, {}, at(new Date("2026-09-24T04:01:00Z")));
    expect(next.ok).toBe(true);
    expect(getDailyBonusClaims().map((r) => r.gamingDate).sort()).toEqual(["2026-09-23", "2026-09-24"]);
  });

  it("grants exactly once when concurrent spins race the same day", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimDailyBonus(claims(), { idempotencyKey: `race-key-${i}000` }, {}, at(NOON_ISH)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(promoCalls()).toHaveLength(1);
    expect(getDailyBonusClaims()).toHaveLength(1);
  });

  it("keeps the day spent after a terminal engine refusal", async () => {
    setEngineHandler(() => ({ ok: false, status: 403, body: { code: "PLAYER_NOT_ACTIVE", message: "suspended" } }));
    const first = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0030" }, {}, at(NOON_ISH));
    expect(first.ok).toBe(false);
    expect(getDailyBonusClaims()[0]!.status).toBe("FAILED");

    setEngineHandler(dedupingEngine());
    const retry = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0031" }, {}, at(NOON_ISH));
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe("ALREADY_CLAIMED_TODAY");
  });

  it("leaves the row REQUESTED on a retryable failure and hands it to the reconciler", async () => {
    setEngineHandler(() => ({ throwKind: "timeout" }));
    const outcome = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0040" }, {}, at(NOON_ISH));
    expect(outcome.ok).toBe(false);

    const row = getDailyBonusClaims()[0]!;
    expect(row.status).toBe("REQUESTED");
    const entry = getJournal(`bonus:daily:${row.id}`)!;
    expect(entry.status).toBe("FAILED");
    expect(entry.retryable).toBe(true);
    if (available) expect(await redis.exists(KEYS.stream)).toBe(1);
  });

  it("refuses a KYC-rejected account without spending the day or calling the engine", async () => {
    resetDb();
    seedUser({ id: USER_ID, email: "bonus@example.test", kycStatus: "REJECTED", trueEnginePlayerId: PLAYER_ID });
    const outcome = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0050" }, {}, at(NOON_ISH));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("KYC_REJECTED");
    expect(getDailyBonusClaims()).toHaveLength(0);
    expect(promoCalls()).toHaveLength(0);
  });
});

describe("the attempt token", () => {
  it("replays the original grant for a repeat of the same token, without a second dispatch", async () => {
    const first = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0060" }, {}, at(NOON_ISH));
    const again = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0060" }, {}, at(NOON_ISH));
    expect(again).toEqual(first);
    expect(promoCalls()).toHaveLength(1);
  });

  it("answers 'in flight' for an unresolved attempt rather than dispatching again", async () => {
    setEngineHandler(() => ({ throwKind: "timeout" }));
    await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0070" }, {}, at(NOON_ISH));
    setEngineHandler(dedupingEngine());
    const again = await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0070" }, {}, at(NOON_ISH));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("ATTEMPT_IN_FLIGHT");
    expect(promoCalls()).toHaveLength(1);
  });
});

describe("the status read", () => {
  it("publishes every slice with its weight (the odds) and opens today", async () => {
    const view = await getDailyBonusStatus(claims(), at(NOON_ISH));
    const offer = getDailyBonusOffer();
    expect(view.segments.map((s) => s.id)).toEqual(offer.slices.map((s) => s.id));
    expect(view.totalWeight).toBe(offer.slices.reduce((n, s) => n + s.weight, 0));
    expect(view.canClaim).toBe(true);
    expect(view.nextClaimAt).toBeNull();
    expect(view.streakDay).toBe(1);
    expect(view.streak[0]!.state).toBe("today");
  });

  it("builds the ladder from the player's consecutive days", async () => {
    seedDailyBonusClaim({ userId: USER_ID, playerId: PLAYER_ID, gamingDate: "2026-09-21" });
    seedDailyBonusClaim({ userId: USER_ID, playerId: PLAYER_ID, gamingDate: "2026-09-22" });
    const view = await getDailyBonusStatus(claims(), at(NOON_ISH));
    expect(view.streakDay).toBe(3);
    expect(view.streak.map((d) => d.state)).toEqual(["claimed", "claimed", "today", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });

  it("closes today once it is claimed and says when it reopens", async () => {
    await claimDailyBonus(claims(), { idempotencyKey: "spin-key-0080" }, {}, at(NOON_ISH));
    const view = await getDailyBonusStatus(claims(), at(NOON_ISH));
    expect(view.canClaim).toBe(false);
    expect(view.nextClaimAt).toBe("2026-09-24T04:00:00.000Z");
    expect(view.streak[0]!.state).toBe("claimed");
  });
});

describe("HTTP routes", () => {
  it("requires authentication for both routes", async () => {
    const get = await app.inject({ method: "GET", url: "/api/bonus/daily" });
    const post = await app.inject({ method: "POST", url: "/api/bonus/daily/claim", payload: { idempotencyKey: "k-unauth-1" } });
    expect(get.statusCode).toBe(401);
    expect(post.statusCode).toBe(401);
    expect(promoCalls()).toHaveLength(0);
  });

  it("refuses a body that tries to name a slice or an amount", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/bonus/daily/claim",
      headers: { authorization: bearer() },
      payload: { idempotencyKey: "k-amount-01", segmentId: "s6", gc_amount: "25000" },
    });
    expect(res.statusCode).toBe(422);
    expect(promoCalls()).toHaveLength(0);
  });

  it("grants over HTTP, then answers 409 for a second spin the same day", async () => {
    if (!available) return;
    const first = await app.inject({
      method: "POST",
      url: "/api/bonus/daily/claim",
      headers: { authorization: bearer() },
      payload: { idempotencyKey: "k-http-0001" },
    });
    expect(first.statusCode).toBe(200);
    const data = first.json().data;
    const slice = getDailyBonusOffer().slices.find((s) => s.id === data.segmentId)!;
    expect(data.gcAmount).toBe(slice.gcAmount);
    expect(data.scAmount).toBe(slice.scAmount);

    const second = await app.inject({
      method: "POST",
      url: "/api/bonus/daily/claim",
      headers: { authorization: bearer() },
      payload: { idempotencyKey: "k-http-0002" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("ALREADY_CLAIMED_TODAY");

    const status = await app.inject({ method: "GET", url: "/api/bonus/daily", headers: { authorization: bearer() } });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.canClaim).toBe(false);
  });
});
