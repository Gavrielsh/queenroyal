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
import { refundAnchor, refundRedemption } from "../src/services/redemption-refund.service";
import { processRedemptionBatch } from "../src/services/redemption-worker.service";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { testStreamKeys } from "./fakes/redis-keys";
import { getJournal, getRedemptions, resetDb, seedRedemption } from "./fakes/prisma.fake";

/**
 * B7 — the compensating credit, on both paths that can strand a player's SC.
 *
 * What these have to prove is not "a function was called". It is that a redemption refused
 * after its debit ends with the player's money back, that the two independent paths to that
 * outcome cannot credit it twice, and that a failure to refund is surfaced rather than
 * swallowed — because a silent refund failure is indistinguishable, in the data, from a
 * refund that worked.
 */

/** This file's private keyspace — see testStreamKeys. */
const KEYS = testStreamKeys("refund");

const ADMIN_SECRET = "test-admin-jwt-secret-0123456789";
const ADMIN_SUB = "operator-sam";
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";
const USER_ID = "66666666-6666-4666-8666-666666666666";
const PLAYER_ID = "engine-player-refund";
const REFUND_PATH = "/api/v1/store/redeem/refund";

let app: FastifyInstance;
let redis: Redis;
let available = false;
let payouts: MockPayoutProvider;
let queue: RedisStreamQueue;

/**
 * An engine that DE-DUPLICATES on operator_transaction_id, as the real one does. Without this
 * the "cannot double-credit" tests would be asserting against a fake that cheerfully credits
 * twice — proving the opposite of what they claim.
 */
const credited = new Map<string, string>();
function dedupingEngine(): (call: EngineCall) => Directive {
  return (call: EngineCall) => {
    if (call.path !== REFUND_PATH) {
      return { ok: false, status: 500, body: { code: "UNEXPECTED" } };
    }
    const anchor = call.body.operator_transaction_id as string;
    const seen = credited.has(anchor);
    if (!seen) credited.set(anchor, `ltx-refund-${credited.size + 1}`);
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
          transaction_type: "REDEMPTION_REFUND",
          family: "SC",
          amount: call.body.amount,
          post_balances: { gc: "0", sc_unplayed: "0", sc_redeemable: "0" },
          // The engine reports CACHED for a replayed anchor — no second credit was made.
          status: seen ? "CACHED" : "PROCESSED",
        },
      },
    };
  };
}

/** Every call the engine received on the refund endpoint. */
const refundCalls = () => engineCalls.filter((c) => c.path === REFUND_PATH);

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
  resetEngine();
  credited.clear();
  setEngineHandler(dedupingEngine());
  payouts = new MockPayoutProvider();
  setPayoutProvider(payouts);
  if (!available) return;
  await redis.del(KEYS.stream, KEYS.dlq, KEYS.schedule);
  queue = new RedisStreamQueue(redis, "refund-test", KEYS);
  setRedemptionQueue(queue);
});

afterEach(async () => {
  setRedemptionQueue(null);
  setPayoutProvider(null);
  if (!available) return;
  await redis.del(KEYS.stream, KEYS.dlq, KEYS.schedule);
});

const bearer = () => ({ authorization: `Bearer ${signAdminToken({ sub: ADMIN_SUB })}` });

/** A redemption whose SC has been debited — the only kind that can be stranded. */
function debited(id: string, amount = "250.0000", status = "UNDER_REVIEW") {
  seedRedemption({
    id,
    userId: USER_ID,
    playerId: PLAYER_ID,
    amount,
    status,
    ledgerTransactionId: `ltx-redeem-${id}`,
    operatorTransactionId: `redeem:${id}`,
  });
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("the refund anchor", () => {
  it("is derived solely from the redemption id, so every caller produces the same one", () => {
    expect(refundAnchor("abc")).toBe("redeem-refund:abc");
    expect(refundAnchor("abc")).toBe(refundAnchor("abc"));
    expect(refundAnchor("abc")).not.toBe(refundAnchor("abd"));
  });
});

describe("admin /reject refunds the player", () => {
  it("credits back the EXACT debited amount and records the refund on the row", async () => {
    if (!available) return;
    const id = debited("rej-refund-1", "250.0000");

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/redemptions/${id}/reject`,
      headers: bearer(),
      payload: { decisionReason: "Source of funds unverified" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "REJECTED", refunded: true });

    const call = refundCalls()[0];
    expect(call).toBeDefined();
    expect(call!.body.operator_transaction_id).toBe(refundAnchor(id));
    expect(call!.body.player_id).toBe(PLAYER_ID);
    // Verbatim: the string that was debited is the string returned. Not 250, not "250".
    expect(call!.body.amount).toBe("250.0000");
    expect(typeof call!.body.amount).toBe("string");
    expect(call!.body.reference_transaction_id).toBe(`ltx-redeem-${id}`);

    const row = getRedemptions()[0]!;
    expect(row.status).toBe("REJECTED");
    expect(row.refundLedgerTransactionId).toBe("ltx-refund-1");
    expect(row.refundedAt).toBeTruthy();
  });

  it("carries the zero-trust headers, because a CREDIT is at least as sensitive as a debit", async () => {
    if (!available) return;
    const id = debited("rej-refund-hdr");
    await app.inject({
      method: "POST",
      url: `/api/admin/redemptions/${id}/reject`,
      headers: bearer(),
      payload: { decisionReason: "not this time" },
    });

    const call = refundCalls()[0]!;
    expect(call.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(call.headers["X-Nonce"]).toBeTruthy();
    expect(call.headers["X-Timestamp"]).toMatch(/^\d+$/);
    expect(call.headers["X-Operator-Code"]).toBe("TEST_OP");
  });

  it("stands by the rejection but REPORTS it when the refund does not land", async () => {
    if (!available) return;
    const id = debited("rej-refund-fail");
    setEngineHandler(() => ({ ok: false, status: 503, body: { code: "ENGINE_UNAVAILABLE", message: "down" } }));

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/redemptions/${id}/reject`,
      headers: bearer(),
      payload: { decisionReason: "AML hold" },
    });

    // The operator's decision is recorded regardless — a ledger hiccup does not un-reject.
    expect(res.statusCode).toBe(200);
    expect(getRedemptions()[0]?.status).toBe("REJECTED");
    // But the response says plainly what did NOT happen, so nobody reads this as settled.
    expect(res.json().data).toMatchObject({ refunded: false });
    expect(res.json().data.refundError).toContain("ENGINE_UNAVAILABLE");
    expect(getRedemptions()[0]?.refundLedgerTransactionId).toBeNull();
    // And the failed intent is journalled, so it is recoverable rather than forgotten.
    expect(getJournal(refundAnchor(id))?.status).toBe("FAILED");
  });

  it("does not refund a redemption whose debit never committed", async () => {
    if (!available) return;
    // No ledgerTransactionId: the engine call failed before committing, so the player never
    // lost the SC. Refunding would credit money they still have.
    seedRedemption({
      id: "rej-no-debit",
      userId: USER_ID,
      playerId: PLAYER_ID,
      amount: "100.0000",
      status: "UNDER_REVIEW",
      ledgerTransactionId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/redemptions/rej-no-debit/reject`,
      headers: bearer(),
      payload: { decisionReason: "never settled" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ refunded: false });
    expect(refundCalls()).toHaveLength(0);
    expect(getRedemptions()[0]?.status).toBe("REJECTED");
  });
});

describe("terminal payout failure refunds the player", () => {
  it("refunds when the rail refuses terminally, and still dead-letters for the operator", async () => {
    if (!available) return;
    const id = debited("pay-refund-1", "480.0000", "APPROVED");
    payouts.failNext(id, "ACCOUNT_CLOSED", false, "payee account is closed");

    await queue.publish({ operatorTransactionId: id, reason: "approved" });
    const outcomes = await processRedemptionBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000 });

    expect(outcomes).toEqual(["abandoned"]);

    const call = refundCalls()[0];
    expect(call).toBeDefined();
    expect(call!.body.operator_transaction_id).toBe(refundAnchor(id));
    expect(call!.body.amount).toBe("480.0000");

    const row = getRedemptions()[0]!;
    // Still PROCESSING, not REJECTED — a payout was attempted and failed, and that remains
    // true after the player is made whole.
    expect(row.status).toBe("PROCESSING");
    expect(row.decisionReason).toContain("ACCOUNT_CLOSED");
    expect(row.refundLedgerTransactionId).toBe("ltx-refund-1");
    expect(row.refundedAt).toBeTruthy();

    // The operator still sees it.
    const dlq = (await redis.xrange(KEYS.dlq, "-", "+")) as Array<[string, string[]]>;
    expect(dlq).toHaveLength(1);
  });

  it("does NOT refund a retryable failure — the payout may still succeed", async () => {
    if (!available) return;
    const id = debited("pay-retry-1", "300.0000", "APPROVED");
    payouts.failNext(id, "RAIL_TIMEOUT", true, "gateway timeout");

    await queue.publish({ operatorTransactionId: id, reason: "approved" });
    const outcomes = await processRedemptionBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000, maxDeliveries: 5 });

    expect(outcomes).toEqual(["stillFailing"]);
    // Refunding here would be the double-spend: the rail may have accepted the payout and we
    // would have both paid and refunded.
    expect(refundCalls()).toHaveLength(0);
    expect(getRedemptions()[0]?.refundLedgerTransactionId).toBeNull();
  });
});

describe("the two paths cannot double-credit", () => {
  it("both derive the SAME anchor, so the engine de-duplicates across them", async () => {
    if (!available) return;
    const id = debited("dbl-1", "125.0000", "APPROVED");

    // Path 1: the worker's terminal failure refunds it.
    payouts.failNext(id, "ACCOUNT_CLOSED", false, "closed");
    await queue.publish({ operatorTransactionId: id, reason: "approved" });
    await processRedemptionBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000 });

    const first = getRedemptions()[0]!.refundLedgerTransactionId;
    expect(first).toBe("ltx-refund-1");

    // Path 2: an operator, seeing the DLQ entry, also refunds it by hand.
    const again = await refundRedemption(id, "operator follow-up");

    expect(again.ok).toBe(true);
    if (again.ok) {
      // The SAME ledger transaction — the engine recognised the anchor and credited nothing.
      expect(again.ledgerTransactionId).toBe(first);
      expect(again.alreadyRefunded).toBe(true);
    }
    // Two calls were made; exactly one credit exists.
    expect(refundCalls()).toHaveLength(2);
    expect(credited.size).toBe(1);
  });

  it("repeated refunds of one redemption credit exactly once, however many times they run", async () => {
    if (!available) return;
    const id = debited("dbl-2", "99.9999", "REJECTED");

    const results = await Promise.all([
      refundRedemption(id, "a"),
      refundRedemption(id, "b"),
      refundRedemption(id, "c"),
      refundRedemption(id, "d"),
    ]);

    for (const r of results) expect(r.ok).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.ledgerTransactionId : "")));
    expect(ids.size).toBe(1); // one credit, four callers
    expect(credited.size).toBe(1);

    // And the amount was never mangled by any of them.
    for (const call of refundCalls()) expect(call.body.amount).toBe("99.9999");
  });
});
