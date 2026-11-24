import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";
import { signAccessToken } from "../src/lib/jwt";
import { RedisStreamQueue, setReconcileQueue } from "../src/lib/reconcile-queue";
import { claimAmoeGrant } from "../src/services/amoe.service";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { testStreamKeys } from "./fakes/redis-keys";
import { getAmoeGrants, getJournal, resetDb, seedAmoeGrant, seedUser } from "./fakes/prisma.fake";

/**
 * C2 — the Alternative Method of Entry, end to end.
 *
 * What these have to prove is not that a function runs. It is that the ONE control standing
 * between the public internet and an unbounded free-coin endpoint actually holds:
 *
 *   - the period cap refuses a second claim, including under concurrency;
 *   - a failed dispatch still consumes the period, so failure is not an issuance hole;
 *   - the claim reaches Zone 1 as an AMOE PROMO_CREDIT with the configured amount, and the
 *     claimant has no way to influence that amount;
 *   - the public disclosure route is reachable without an account, because a free entry
 *     nobody can read about is not a free entry.
 */

const JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";
const PROMO_PATH = "/api/v1/store/promo-grant";

/**
 * This file's PRIVATE reconcile keyspace — see testStreamKeys.
 *
 * The retryable-failure test below publishes a reconcile event, and the default queue writes
 * to the shared `reconcile:events`. Vitest runs suites in parallel against one Redis, so
 * leaving that on the default would leak this file's event into another suite's keyspace and
 * fail ITS "publishes to its own configured stream and nowhere else" assertion — a red test in
 * a file this change never touched, reproducible only in a full run. Same fix as B7.
 */
const KEYS = testStreamKeys("amoe");
const SESSION_PATH = "/api/v1/session";

const USER_ID = "77777777-7777-4777-8777-777777777777";
const PLAYER_ID = "engine-player-amoe";

let app: FastifyInstance;
let redis: Redis;
let available = false;

/** Every call the engine received on the promo-grant endpoint. */
const promoCalls = () => engineCalls.filter((c) => c.path === PROMO_PATH);

/**
 * An engine that DE-DUPLICATES on operator_transaction_id, as the real one does, and answers
 * the session snapshot. Without the de-duplication the idempotency assertions would be made
 * against a fake that cheerfully credits twice — proving the opposite of what they claim.
 */
const credited = new Map<string, string>();
function dedupingEngine(playerStatus = "ACTIVE"): (call: EngineCall) => Directive {
  return (call: EngineCall) => {
    if (call.path === SESSION_PATH) {
      return {
        ok: true,
        status: 200,
        body: {
          player_id: PLAYER_ID,
          balances: { gc: "0", sc_unplayed: "0", sc_redeemable: "0" },
          status: playerStatus,
          playthrough_outstanding: "0",
        },
      };
    }
    if (call.path !== PROMO_PATH) {
      return { ok: false, status: 500, body: { code: "UNEXPECTED", message: call.path } };
    }
    const body = call.body as Record<string, unknown>;
    const anchor = body.operator_transaction_id as string;
    const seen = credited.has(anchor);
    if (!seen) credited.set(anchor, `ltx-promo-${credited.size + 1}`);
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
          amount: body.sc_amount,
          post_balances: { gc: "0", sc_unplayed: "5.0000", sc_redeemable: "0" },
          status: seen ? "CACHED" : "PROCESSED",
        },
      },
    };
  };
}

function bearer(userId = USER_ID): string {
  return `Bearer ${signAccessToken({ sub: userId, email: "amoe@example.test", kycStatus: "PENDING", vipLevel: 0 })}`;
}

const claims = (userId = USER_ID) => ({
  sub: userId,
  email: "amoe@example.test",
  kycStatus: "PENDING",
  vipLevel: 0,
});

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  // Probe Redis BEFORE building the app. The claim limiter is FAIL CLOSED, so without a
  // reachable Redis every route test would get a 503 — a green suite that proved the limiter
  // refuses everything, rather than that it admits the first claim and throttles the rest.
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

  // The shared test env deliberately leaves REDIS_URL unset so most suites run without one.
  // These route tests need the limiter to actually work, so it is set for this file only and
  // removed in afterAll — the same per-file pattern the other integration suites use.
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
  seedUser({ id: USER_ID, email: "amoe@example.test", kycStatus: "PENDING", trueEnginePlayerId: PLAYER_ID });
  // Clear this suite's rate-limit keys so an earlier test's hits cannot throttle a later one.
  if (!available) {
    setReconcileQueue(null);
    return;
  }
  const keys = await redis.keys("ratelimit:amoe:claim:*");
  if (keys.length > 0) await redis.del(...keys);
  await redis.del(KEYS.stream, KEYS.dlq, KEYS.schedule);
  setReconcileQueue(new RedisStreamQueue(redis, "amoe-test", KEYS));
});

afterEach(() => {
  resetEngine();
  setReconcileQueue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The Zone 1 dispatch pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("the Zone 1 dispatch", () => {
  it("issues an AMOE PROMO_CREDIT and records the grant", async () => {
    const outcome = await claimAmoeGrant(claims(), { idempotencyKey: "claim-key-0001" }, { jurisdiction: "US-NJ" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("GRANTED");
    expect(outcome.data.scAmount).toBe("5.0000");
    expect(outcome.data.ledgerTransactionId).toBe("ltx-promo-1");

    // The payload Zone 1 received.
    const calls = promoCalls();
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.channel).toBe("AMOE");
    expect(body.sc_amount).toBe("5.0000");
    expect(body.player_id).toBe(PLAYER_ID);
    // The engine REQUIRES a channel_reference for AMOE, and it must be traceable back here.
    expect(body.channel_reference).toBe(`AMOE-${outcome.data.grantId}`);
    expect(body.operator_transaction_id).toBe(`amoe:${outcome.data.grantId}`);

    // The row, and the journal that preceded the call.
    const grants = getAmoeGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.status).toBe("GRANTED");
    expect(grants[0]!.ledgerTransactionId).toBe("ltx-promo-1");

    const entry = getJournal(`amoe:${outcome.data.grantId}`);
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("PROMO_GRANT");
    expect(entry!.status).toBe("SUCCEEDED");
  });

  /**
   * THE ZERO-TRUST PERIMETER, on the newest client method.
   *
   * `sendPromoGrant` goes through the shared `postTx`, so the signing logic itself is already
   * pinned byte-for-byte against the engine's own `canonicalPayload` in redeem.test.ts. What
   * that golden-vector test cannot see is whether a NEW method was wired through that path at
   * all — a method that posted with `fetch` directly would sign nothing and still return a
   * plausible result. This asserts the headers actually left the building.
   */
  it("signs the grant with the full four-header zero-trust set", async () => {
    await claimAmoeGrant(claims(), { idempotencyKey: "claim-key-hmac" }, { jurisdiction: "US-NJ" });

    const call = promoCalls()[0]!;
    expect(call.method).toBe("POST");
    for (const header of ["X-Operator-Code", "X-Signature", "X-Timestamp", "X-Nonce"]) {
      expect(call.headers[header]).toBeTruthy();
    }
    // Hex HMAC-SHA256 — 64 hex characters, never base64 or a truncation.
    expect(call.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // Unix SECONDS, which is what the engine's ReplayGuard window is measured in.
    expect(call.headers["X-Timestamp"]).toMatch(/^\d{10}$/);
  });

  /**
   * NO FLOAT CROSSES THE BOUNDARY. Every money field on the wire must be a JSON string; a
   * native number would mean JSON.parse had already turned it into an IEEE-754 double before
   * the engine ever saw it, and no care downstream recovers a scale the parse destroyed.
   */
  it("puts every money field on the wire as a decimal string", async () => {
    await claimAmoeGrant(claims(), { idempotencyKey: "claim-key-types" }, { jurisdiction: "US-NJ" });

    const body = promoCalls()[0]!.body as Record<string, unknown>;
    for (const field of ["sc_amount", "gc_amount"]) {
      expect(typeof body[field]).toBe("string");
      expect(body[field]).toMatch(/^\d+\.\d{4}$/);
    }
    // And there is no field through which SC_REDEEMABLE could be requested at all.
    expect(Object.keys(body)).not.toContain("sc_redeemable_amount");
    expect(Object.keys(body)).not.toContain("sc_redeemable");
  });

  /**
   * ZERO FINANCIAL STATE. The engine's response carries post_balances and the row must not
   * keep it — the moment Zone 2 holds a post-grant figure it owns a second copy of the truth.
   */
  it("keeps no balance from the engine's response", async () => {
    await claimAmoeGrant(claims(), { idempotencyKey: "claim-key-0002" }, { jurisdiction: "US-NJ" });

    const row = getAmoeGrants()[0]!;
    const serialized = JSON.stringify(row);
    for (const forbidden of ["post_balances", "postBalances", "balance", "sc_unplayed"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("journals the intent BEFORE calling the engine", async () => {
    // A terminal refusal proves the ordering: the journal row must exist even though the call
    // failed, which is only possible if it was written first.
    setEngineHandler((call) =>
      call.path === SESSION_PATH
        ? { ok: true, status: 200, body: { player_id: PLAYER_ID, balances: {}, status: "ACTIVE", playthrough_outstanding: "0" } }
        : { ok: false, status: 403, body: { code: "PLAYER_NOT_ACTIVE", message: "blocked" } },
    );

    const outcome = await claimAmoeGrant(claims(), { idempotencyKey: "claim-key-0003" }, { jurisdiction: "US-NJ" });
    expect(outcome.ok).toBe(false);

    const grant = getAmoeGrants()[0]!;
    const entry = getJournal(`amoe:${grant.id}`);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("FAILED");
    expect(grant.status).toBe("FAILED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The period cap and the uniqueness constraint
// ─────────────────────────────────────────────────────────────────────────────

describe("the period cap", () => {
  it("refuses a second claim in the same period", async () => {
    const first = await claimAmoeGrant(claims(), { idempotencyKey: "claim-key-0010" }, { jurisdiction: "US-NJ" });
    expect(first.ok).toBe(true);

    const second = await claimAmoeGrant(claims(), { idempotencyKey: "claim-key-0011" }, { jurisdiction: "US-NJ" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.error.code).toBe("PERIOD_ALREADY_CLAIMED");

    // And crucially: the engine was never asked a second time.
    expect(promoCalls()).toHaveLength(1);
    expect(getAmoeGrants()).toHaveLength(1);
  });

  it("allows a claim once the period rolls over", async () => {
    const day1 = () => new Date("2026-09-18T12:00:00Z");
    const day2 = () => new Date("2026-09-19T12:00:00Z");

    const first = await claimAmoeGrant(claims(), { idempotencyKey: "k-0020" }, { jurisdiction: "US-NJ" }, { now: day1 });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.grantPeriod).toBe("DAY:2026-09-18");

    const sameDay = await claimAmoeGrant(claims(), { idempotencyKey: "k-0021" }, { jurisdiction: "US-NJ" }, { now: day1 });
    expect(sameDay.ok).toBe(false);

    const nextDay = await claimAmoeGrant(claims(), { idempotencyKey: "k-0022" }, { jurisdiction: "US-NJ" }, { now: day2 });
    expect(nextDay.ok).toBe(true);
    if (nextDay.ok) expect(nextDay.data.grantPeriod).toBe("DAY:2026-09-19");

    expect(promoCalls()).toHaveLength(2);
  });

  /**
   * THE RACE THE UNIQUE INDEX EXISTS FOR.
   *
   * Both claims pass the service's pre-flight read — each reads before the other writes — so
   * if the cap were a read-then-write check in application code, both would be granted. Only
   * the database constraint refuses the second, and this asserts that exactly one set of coins
   * was issued no matter how the two interleave.
   */
  it("issues exactly one grant when concurrent claims race the same period", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimAmoeGrant(claims(), { idempotencyKey: `race-key-${i}` }, { jurisdiction: "US-NJ" }),
      ),
    );

    const granted = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);

    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      if (!r.ok) expect(r.error.code).toBe("PERIOD_ALREADY_CLAIMED");
    }

    // The engine issued coins exactly once, and one row exists.
    expect(promoCalls()).toHaveLength(1);
    expect(getAmoeGrants()).toHaveLength(1);
  });

  it("caps per account, not globally — a second player may still claim", async () => {
    const other = "88888888-8888-4888-8888-888888888888";
    seedUser({ id: other, email: "other@example.test", kycStatus: "PENDING", trueEnginePlayerId: "engine-player-other" });

    const a = await claimAmoeGrant(claims(), { idempotencyKey: "k-0030" }, { jurisdiction: "US-NJ" });
    const b = await claimAmoeGrant(claims(other), { idempotencyKey: "k-0031" }, { jurisdiction: "US-NJ" });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(promoCalls()).toHaveLength(2);
  });

  /**
   * A FAILED DISPATCH STILL CONSUMES THE PERIOD.
   *
   * Releasing it on failure looks kinder and turns any reliably-failing condition into an
   * unbounded retry loop pointed at an unbounded ledger endpoint. This pins the conservative
   * direction so a future "improvement" has to argue with a red test.
   */
  it("keeps the period spent after a terminal engine refusal", async () => {
    setEngineHandler((call) =>
      call.path === SESSION_PATH
        ? { ok: true, status: 200, body: { player_id: PLAYER_ID, balances: {}, status: "ACTIVE", playthrough_outstanding: "0" } }
        : { ok: false, status: 403, body: { code: "PLAYER_NOT_ACTIVE", message: "blocked" } },
    );
    const failed = await claimAmoeGrant(claims(), { idempotencyKey: "k-0040" }, { jurisdiction: "US-NJ" });
    expect(failed.ok).toBe(false);
    expect(getAmoeGrants()[0]!.status).toBe("FAILED");

    // Now the engine would accept — but the period is spent.
    setEngineHandler(dedupingEngine());
    const retry = await claimAmoeGrant(claims(), { idempotencyKey: "k-0041" }, { jurisdiction: "US-NJ" });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe("PERIOD_ALREADY_CLAIMED");
  });

  /**
   * A RETRYABLE failure is different in kind: the credit may have committed at the engine
   * without us seeing the response, so asserting FAILED would claim an outcome we do not know.
   * The row stays REQUESTED for the reconciler.
   */
  it("leaves the row REQUESTED on a retryable failure so the reconciler can resolve it", async () => {
    setEngineHandler((call) =>
      call.path === SESSION_PATH
        ? { ok: true, status: 200, body: { player_id: PLAYER_ID, balances: {}, status: "ACTIVE", playthrough_outstanding: "0" } }
        : { throwKind: "timeout" },
    );

    const outcome = await claimAmoeGrant(claims(), { idempotencyKey: "k-0050" }, { jurisdiction: "US-NJ" });
    expect(outcome.ok).toBe(false);

    const grant = getAmoeGrants()[0]!;
    expect(grant.status).toBe("REQUESTED");
    expect(grant.ledgerTransactionId).toBeNull();

    const entry = getJournal(`amoe:${grant.id}`);
    expect(entry!.status).toBe("FAILED");
    expect(entry!.retryable).toBe(true);

    // The reconcile event was published — to THIS file's keyspace, not the shared default.
    // Asserting the destination makes the isolation a property under test rather than a
    // convention that a later edit could quietly drop.
    if (available) {
      expect(await redis.exists(KEYS.stream)).toBe(1);
      expect(await redis.exists("reconcile:events")).toBe(0);
    }
  });

  it("refuses when a grant already exists for the period, seeded out of band", async () => {
    seedAmoeGrant({
      userId: USER_ID,
      playerId: PLAYER_ID,
      grantPeriod: "DAY:2026-09-18",
      scAmount: "5.0000",
      gcAmount: "0.0000",
      operatorTransactionId: "amoe:seeded",
      channelReference: "AMOE-seeded",
      claimAttemptKey: "seeded-attempt-key",
    });

    const outcome = await claimAmoeGrant(
      claims(),
      { idempotencyKey: "k-0060" },
      { jurisdiction: "US-NJ" },
      { now: () => new Date("2026-09-18T12:00:00Z") },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("PERIOD_ALREADY_CLAIMED");
    expect(promoCalls()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The attempt token
// ─────────────────────────────────────────────────────────────────────────────

describe("the attempt token", () => {
  /**
   * The failure mode this exists for: a client submits, the response is lost, the client
   * retries. Without the token it is told the period is spent — indistinguishable, from where
   * it stands, from being refused for abuse — and it has no way to learn it actually succeeded.
   */
  it("replays the original success for a repeat of the same token", async () => {
    const first = await claimAmoeGrant(claims(), { idempotencyKey: "same-token-01" }, { jurisdiction: "US-NJ" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await claimAmoeGrant(claims(), { idempotencyKey: "same-token-01" }, { jurisdiction: "US-NJ" });

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data).toEqual(first.data);
    // And the engine was not asked again.
    expect(promoCalls()).toHaveLength(1);
  });

  it("refuses a DIFFERENT token in the same period as a spent period, not a replay", async () => {
    const first = await claimAmoeGrant(claims(), { idempotencyKey: "token-aaa" }, { jurisdiction: "US-NJ" });
    expect(first.ok).toBe(true);

    const other = await claimAmoeGrant(claims(), { idempotencyKey: "token-bbb" }, { jurisdiction: "US-NJ" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe("PERIOD_ALREADY_CLAIMED");
  });

  /**
   * A token is client-chosen, so two strangers picking the same string is ordinary. Neither
   * may read the other's outcome, and neither may block the other's claim — which is why the
   * unique is per user rather than global.
   */
  it("scopes the token per account, so two users may reuse one string", async () => {
    const other = "aaaaaaa1-0000-4000-8000-000000000000";
    seedUser({ id: other, email: "shared@example.test", kycStatus: "PENDING", trueEnginePlayerId: "engine-shared" });

    const a = await claimAmoeGrant(claims(), { idempotencyKey: "collide-token" }, { jurisdiction: "US-NJ" });
    const b = await claimAmoeGrant(claims(other), { idempotencyKey: "collide-token" }, { jurisdiction: "US-NJ" });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.data.grantId).not.toBe(b.data.grantId);
  });

  /**
   * A retryable failure leaves the attempt unresolved. Replaying it must NOT dispatch again —
   * the credit may already have committed at the engine without us seeing the response.
   */
  it("answers 'in flight' rather than re-dispatching an unresolved attempt", async () => {
    setEngineHandler((call) =>
      call.path === SESSION_PATH
        ? { ok: true, status: 200, body: { player_id: PLAYER_ID, balances: {}, status: "ACTIVE", playthrough_outstanding: "0" } }
        : { throwKind: "timeout" },
    );
    const first = await claimAmoeGrant(claims(), { idempotencyKey: "inflight-token" }, { jurisdiction: "US-NJ" });
    expect(first.ok).toBe(false);

    const callsAfterFirst = promoCalls().length;
    const replay = await claimAmoeGrant(claims(), { idempotencyKey: "inflight-token" }, { jurisdiction: "US-NJ" });

    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe("ATTEMPT_IN_FLIGHT");
      expect(replay.status).toBe(409);
    }
    // The decisive assertion: no second dispatch.
    expect(promoCalls()).toHaveLength(callsAfterFirst);
  });

  it("replays a terminal failure as a failure, naming the spent period", async () => {
    setEngineHandler((call) =>
      call.path === SESSION_PATH
        ? { ok: true, status: 200, body: { player_id: PLAYER_ID, balances: {}, status: "ACTIVE", playthrough_outstanding: "0" } }
        : { ok: false, status: 403, body: { code: "PLAYER_NOT_ACTIVE", message: "blocked" } },
    );
    const first = await claimAmoeGrant(claims(), { idempotencyKey: "failed-token" }, { jurisdiction: "US-NJ" });
    expect(first.ok).toBe(false);

    const replay = await claimAmoeGrant(claims(), { idempotencyKey: "failed-token" }, { jurisdiction: "US-NJ" });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe("ATTEMPT_FAILED");
      expect(replay.error.details).toMatchObject({ grantPeriod: expect.stringMatching(/^DAY:/) });
    }
  });

  it("records the fraud-review context on the row", async () => {
    await claimAmoeGrant(
      claims(),
      { idempotencyKey: "context-token" },
      { jurisdiction: "US-NJ", ip: "203.0.113.9" },
    );
    const row = getAmoeGrants()[0]!;
    expect(row.claimIp).toBe("203.0.113.9");
    expect(row.claimJurisdiction).toBe("US-NJ");
    expect(row.claimAttemptKey).toBe("context-token");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The policy gates, applied
// ─────────────────────────────────────────────────────────────────────────────

describe("the pre-flight gates", () => {
  it("refuses a blocked player without consuming the period", async () => {
    setEngineHandler(dedupingEngine("SELF_EXCLUDED"));

    const outcome = await claimAmoeGrant(claims(), { idempotencyKey: "k-0070" }, { jurisdiction: "US-NJ" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("PLAYER_NOT_ACTIVE");

    // Refused BEFORE the row was taken, so a self-excluded player who later returns has not
    // silently lost that period's entry.
    expect(getAmoeGrants()).toHaveLength(0);
    expect(promoCalls()).toHaveLength(0);
  });

  it("refuses a closed jurisdiction", async () => {
    const outcome = await claimAmoeGrant(claims(), { idempotencyKey: "k-0080" }, { jurisdiction: "US-WA" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("JURISDICTION_BLOCKED");
      expect(outcome.status).toBe(403);
    }
    expect(getAmoeGrants()).toHaveLength(0);
  });

  /**
   * The argued default: an unverified player may take the free entry. Requiring verification
   * to obtain a STATUTORY free entry is a barrier at the wrong end — redemption already
   * requires VERIFIED, so a multi-accounter cannot cash any of it out.
   */
  it("admits an unverified (PENDING) player, because the free route must not require KYC", async () => {
    const outcome = await claimAmoeGrant(claims(), { idempotencyKey: "k-0090" }, { jurisdiction: "US-NJ" });
    expect(outcome.ok).toBe(true);
  });

  /**
   * An advisory read that fails must not close the statutory route. The engine re-checks under
   * the wallet lock and is the authority; failing closed here would turn a degraded
   * optimisation into a compliance outage.
   */
  it("proceeds when the advisory status read is unavailable and lets the engine decide", async () => {
    const outcome = await claimAmoeGrant(
      claims(),
      { idempotencyKey: "k-0100" },
      { jurisdiction: "US-NJ" },
      { playerStatus: async () => null },
    );
    expect(outcome.ok).toBe(true);
    expect(promoCalls()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The routes
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/amoe", () => {
  /**
   * UNAUTHENTICATED ON PURPOSE. A free entry method discoverable only from inside a logged-in
   * account is not meaningfully available — including to a regulator with no account.
   */
  it("serves the statutory disclosure with no credentials at all", async () => {
    const res = await app.inject({ method: "GET", url: "/api/amoe" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.noPurchaseNecessary).toMatch(/no purchase is necessary/i);
    expect(body.data.howToEnter.length).toBeGreaterThan(0);
    expect(body.data.mailingAddress.length).toBeGreaterThan(0);
    // The offer is disclosed, so a reader can compare it against what a purchase yields.
    expect(body.data.grant.scAmount).toBe("5.0000");
    expect(body.data.limits.join(" ")).toMatch(/one free entry per person/i);
  });

  it("states that verification is not required to enter", async () => {
    const res = await app.inject({ method: "GET", url: "/api/amoe" });
    expect(res.json().data.eligibility.join(" ")).toMatch(/verification is not required/i);
  });
});

describe("POST /api/amoe/claim", () => {
  it("rejects an unauthenticated claim", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/amoe/claim",
      payload: { idempotencyKey: "claim-key-unauth" },
    });
    expect(res.statusCode).toBe(401);
    expect(promoCalls()).toHaveLength(0);
  });

  /**
   * THE CLAIMANT DOES NOT CHOOSE THE GRANT SIZE.
   *
   * The schema is `.strict()` and carries no money field, so a hopeful `sc_amount` is a 422
   * rather than a silent ignore. Refusing loudly matters: a client whose field was quietly
   * dropped would believe it worked.
   */
  it("refuses a body that tries to name its own amount", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/amoe/claim",
      headers: { authorization: bearer() },
      payload: { idempotencyKey: "claim-key-amount", sc_amount: "999999.0000" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(promoCalls()).toHaveLength(0);
  });

  it("grants on a well-formed authenticated claim", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/amoe/claim",
      headers: { authorization: bearer() },
      payload: { idempotencyKey: "claim-key-ok-01" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe("GRANTED");
    expect(body.data.scAmount).toBe("5.0000");
    expect(promoCalls()).toHaveLength(1);
  });

  it("returns 409 and names the period on a repeat claim", async () => {
    if (!available) return;
    const first = await app.inject({
      method: "POST",
      url: "/api/amoe/claim",
      headers: { authorization: bearer() },
      payload: { idempotencyKey: "claim-key-dup-01" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/amoe/claim",
      headers: { authorization: bearer() },
      payload: { idempotencyKey: "claim-key-dup-02" },
    });

    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error.code).toBe("PERIOD_ALREADY_CLAIMED");
    // Named, because a claimant told only "no" cannot tell a working cap from a broken route.
    expect(body.error.details.grantPeriod).toMatch(/^DAY:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rate limits
// ─────────────────────────────────────────────────────────────────────────────

describe("the claim rate limits", () => {
  it("throttles an account that keeps claiming, with Retry-After", async () => {
    if (!available) return;

    // The configured per-account limit is 3/hour. The first claim succeeds and the next two
    // are refused by the period cap; the fourth is refused by the LIMITER, before any of the
    // gates — which is what stops a caller probing the route for free.
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/amoe/claim",
        headers: { authorization: bearer() },
        payload: { idempotencyKey: `claim-key-rl-${i}` },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.headers["retry-after"]).toBeDefined();
        expect(res.json().error.code).toBe("RATE_LIMITED");
      }
    }

    expect(codes[0]).toBe(200);
    expect(codes).toContain(429);
    // Exactly one grant, no matter how many attempts were made.
    expect(getAmoeGrants().filter((g) => g.status === "GRANTED")).toHaveLength(1);
  });

  /**
   * The per-IP limiter is the only control that sees one person driving MANY accounts. Each
   * account here is under its own per-account limit, so a per-account limiter alone would
   * admit every one of them.
   */
  it("throttles many accounts claiming from one address", async () => {
    if (!available) return;

    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = `9000000${i}-0000-4000-8000-000000000000`;
      seedUser({ id, email: `multi${i}@example.test`, kycStatus: "PENDING", trueEnginePlayerId: `engine-multi-${i}` });
      const res = await app.inject({
        method: "POST",
        url: "/api/amoe/claim",
        headers: { authorization: bearer(id), "x-forwarded-for": "203.0.113.55" },
        payload: { idempotencyKey: `claim-key-ip-${i}` },
      });
      codes.push(res.statusCode);
    }

    // The per-IP limit is 10/hour, so the tail must be throttled even though every account is
    // individually within its own limit.
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(10);
  });

  /**
   * The two limiters return the SAME opaque body. A distinct code would tell a probing client
   * which limit it hit, and therefore how many accounts it may drive from one address before
   * the address becomes the binding constraint.
   */
  it("does not reveal which of the two limits was hit", async () => {
    if (!available) return;

    const bodies = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/amoe/claim",
        headers: { authorization: bearer() },
        payload: { idempotencyKey: `claim-key-op-${i}` },
      });
      if (res.statusCode === 429) bodies.add(res.body);
    }
    expect(bodies.size).toBeLessThanOrEqual(1);
  });
});
