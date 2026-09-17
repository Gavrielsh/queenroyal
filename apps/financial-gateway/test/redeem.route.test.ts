import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The in-memory Prisma fake, installed before anything imports the real singleton.
import { vi } from "vitest";
vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { signAccessToken } from "../src/lib/jwt";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { getJournal, getRedemptions, resetDb, seedRedemption, seedUser } from "./fakes/prisma.fake";

/**
 * POST /api/store/redeem — the money-OUT perimeter, end to end through Fastify.
 *
 * These drive the REAL route, the REAL service and the REAL B3 policy, with only Prisma and
 * the engine's HTTP surface faked. That is the point: the policy already has exhaustive unit
 * coverage, so what is under test here is the WIRING — that each rule is actually reachable
 * from an HTTP request, that a refusal never reaches the ledger, and that a success journals
 * and records in the right order.
 */

const USER_ID = "22222222-2222-4222-8222-222222222222";
const PLAYER_ID = "engine-player-redeem";

/** Engine redeem success envelope. */
function okRedeem(opTx: string, ledgerTxId = "ltx-redeem-ok"): Directive {
  return {
    ok: true,
    status: 200,
    body: {
      code: "OK",
      result: {
        operator_code: "TEST_OP",
        operator_transaction_id: opTx,
        ledger_transaction_id: ledgerTxId,
        player_id: PLAYER_ID,
        transaction_type: "WITHDRAWAL",
        family: "SC",
        amount: "100.0000",
        // Present on the wire and deliberately never persisted by Zone 2.
        post_balances: { gc: "0", sc_unplayed: "0", sc_redeemable: "900.0000" },
        status: "PROCESSED",
      },
    },
  };
}

const unexpected: Directive = { ok: false, status: 500, body: { code: "UNEXPECTED" } };

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  resetDb();
  resetEngine();
  seedUser({ id: USER_ID, email: "redeemer@player.io", kycStatus: "VERIFIED", trueEnginePlayerId: PLAYER_ID });
  token = signAccessToken({ sub: USER_ID, email: "redeemer@player.io" });
});

function redeem(payload: unknown, bearer: string | null = token) {
  return app.inject({
    method: "POST",
    url: "/api/store/redeem",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: payload as object,
  });
}

/** A body that satisfies the schema and every policy rule. */
function goodBody(over: Record<string, unknown> = {}) {
  return { amount: "100.0000", idempotencyKey: "redeem-attempt-0001", ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/store/redeem — perimeter", () => {
  it("→ 401 without a bearer token, before any service or engine call", async () => {
    const res = await redeem(goodBody(), null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(engineCalls).toHaveLength(0);
    expect(getRedemptions()).toHaveLength(0);
  });
});

describe("POST /api/store/redeem — network boundary (the float ban's first line)", () => {
  it("→ 422 for a NATIVE JSON NUMBER amount, which never reaches the service", async () => {
    // JSON.parse has already made this an IEEE-754 double; the only safe move is to refuse it.
    const res = await redeem({ amount: 125.5, idempotencyKey: "redeem-attempt-0001" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(engineCalls).toHaveLength(0);
    expect(getRedemptions()).toHaveLength(0);
  });

  it.each([
    ["an integer number", 100],
    ["zero as a number", 0],
    ["a float with 4dp", 100.25],
    ["a numeric string in exponent form", "1e3"],
    ["a negative amount", "-100.0000"],
    ["zero", "0"],
    ["five decimal places", "100.00001"],
    ["null", null],
    ["a boolean", true],
    ["an object", { value: "100" }],
  ])("→ 422 for %s", async (_label, amount) => {
    const res = await redeem({ amount, idempotencyKey: "redeem-attempt-0001" });
    expect(res.statusCode).toBe(422);
    expect(engineCalls).toHaveLength(0);
  });

  it("→ 422 for a missing or too-short attempt token", async () => {
    expect((await redeem({ amount: "100.0000" })).statusCode).toBe(422);
    expect((await redeem({ amount: "100.0000", idempotencyKey: "short" })).statusCode).toBe(422);
    expect(engineCalls).toHaveLength(0);
  });
});

describe("POST /api/store/redeem — policy gates", () => {
  it.each([
    ["PENDING", "KYC_NOT_VERIFIED"],
    ["REJECTED", "KYC_NOT_VERIFIED"],
  ])("→ 403 %s KYC, and nothing is debited", async (kycStatus, code) => {
    seedUser({ id: USER_ID, email: "redeemer@player.io", kycStatus, trueEnginePlayerId: PLAYER_ID });
    setEngineHandler(() => unexpected);

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(code);
    // The gate is real: no engine call, no orchestration row, no journal row.
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
    expect(getRedemptions()).toHaveLength(0);
    expect(getJournal("redeem:redeem-attempt-0001")).toBeUndefined();
  });

  it("→ 422 BELOW_MINIMUM under the configured floor", async () => {
    setEngineHandler(() => unexpected);
    const res = await redeem(goodBody({ amount: "49.9999" }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("BELOW_MINIMUM");
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
  });

  it("→ 422 ABOVE_PER_REQUEST_CAP over the single-request ceiling", async () => {
    setEngineHandler(() => unexpected);
    const res = await redeem(goodBody({ amount: "2500.0001" }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ABOVE_PER_REQUEST_CAP");
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
  });

  it("→ 422 DAILY_CAP_EXCEEDED counting the player's earlier redemptions today", async () => {
    // Two earlier redemptions today, each individually legal.
    seedRedemption({ playerId: PLAYER_ID, userId: USER_ID, amount: "2500.0000", status: "UNDER_REVIEW" });
    seedRedemption({ playerId: PLAYER_ID, userId: USER_ID, amount: "2400.0000", status: "PAID" });
    setEngineHandler(() => unexpected);

    // 4900 + 150 = 5050 > the 5000 daily cap.
    const res = await redeem(goodBody({ amount: "150.0000" }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.refusals).toContain("DAILY_CAP_EXCEEDED");
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
  });

  it("lands exactly ON the daily cap and is allowed", async () => {
    seedRedemption({ playerId: PLAYER_ID, userId: USER_ID, amount: "4900.0000", status: "UNDER_REVIEW" });
    setEngineHandler((c: EngineCall) =>
      c.path === "/api/v1/store/redeem" ? okRedeem(c.body.operator_transaction_id) : unexpected,
    );

    const res = await redeem(goodBody({ amount: "100.0000" })); // 4900 + 100 = exactly 5000
    expect(res.statusCode).toBe(200);
  });

  it("does NOT count a REJECTED or CANCELLED_BY_PLAYER redemption against the cap", async () => {
    // No money moved for these, so they must not consume the player's headroom.
    seedRedemption({ playerId: PLAYER_ID, userId: USER_ID, amount: "2500.0000", status: "REJECTED" });
    seedRedemption({ playerId: PLAYER_ID, userId: USER_ID, amount: "2400.0000", status: "CANCELLED_BY_PLAYER" });
    setEngineHandler((c: EngineCall) =>
      c.path === "/api/v1/store/redeem" ? okRedeem(c.body.operator_transaction_id) : unexpected,
    );

    const res = await redeem(goodBody({ amount: "150.0000" }));
    expect(res.statusCode).toBe(200);
  });

  it("does not count ANOTHER player's redemptions against this player's cap", async () => {
    seedRedemption({ playerId: "someone-else", userId: "other", amount: "5000.0000", status: "PAID" });
    setEngineHandler((c: EngineCall) =>
      c.path === "/api/v1/store/redeem" ? okRedeem(c.body.operator_transaction_id) : unexpected,
    );

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(200);
  });

  it("→ 422 MONTHLY_CAP_EXCEEDED from earlier days, which the DAILY window does not count", async () => {
    // Driven at the SERVICE with a pinned clock rather than over HTTP. "Earlier this month" is
    // the entire substance of this rule, and on the 1st of a month there are no earlier days —
    // a route-level version of this test would quietly prove nothing once a month. Fastify's
    // inject cannot run under fake timers, so the clock is injected instead.
    const { requestRedemption } = await import("../src/services/redemption.service");
    const now = new Date("2026-09-15T12:00:00Z");

    // 17600 redeemed earlier in the month, none of it today.
    for (const [day, amount] of [["05", "9000.0000"], ["09", "8600.0000"]] as const) {
      seedRedemption({
        playerId: PLAYER_ID,
        userId: USER_ID,
        amount,
        status: "PAID",
        createdAt: new Date(`2026-09-${day}T08:00:00Z`),
      });
    }
    setEngineHandler(() => unexpected);

    // Today's total would be 0 + 2500 = 2500, well inside the 5000 daily cap.
    // The month's would be 17600 + 2500 = 20100, just past the 20000 monthly cap.
    const outcome = await requestRedemption(
      { sub: USER_ID, email: "redeemer@player.io" },
      { amount: "2500.0000", idempotencyKey: "redeem-attempt-month" },
      {},
      { now: () => now },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(422);
      const refusals = (outcome.error.details as { refusals: string[] }).refusals;
      expect(refusals).toContain("MONTHLY_CAP_EXCEEDED");
      expect(refusals).not.toContain("DAILY_CAP_EXCEEDED");
    }
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
  });

  it("counts only the CURRENT month: a redemption from last month is outside both windows", async () => {
    const { requestRedemption } = await import("../src/services/redemption.service");
    const now = new Date("2026-09-15T12:00:00Z");

    seedRedemption({
      playerId: PLAYER_ID,
      userId: USER_ID,
      amount: "19000.0000",
      status: "PAID",
      createdAt: new Date("2026-08-31T23:59:59Z"), // one second before the month began
    });
    setEngineHandler((c: EngineCall) =>
      c.path === "/api/v1/store/redeem" ? okRedeem(c.body.operator_transaction_id) : unexpected,
    );

    const outcome = await requestRedemption(
      { sub: USER_ID, email: "redeemer@player.io" },
      { amount: "2500.0000", idempotencyKey: "redeem-attempt-lastmonth" },
      {},
      { now: () => now },
    );
    expect(outcome.ok).toBe(true);
  });

  it("wires the Zone-1-owned facts through the policy when a source supplies them", async () => {
    // The two gates the gateway cannot currently source for itself (see EngineOwnedFacts).
    // Supplying them proves the wiring is real and not decorative.
    const { requestRedemption } = await import("../src/services/redemption.service");
    setEngineHandler(() => unexpected);

    const blocked = await requestRedemption(
      { sub: USER_ID, email: "redeemer@player.io" },
      { amount: "100.0000", idempotencyKey: "redeem-attempt-status" },
      {},
      { engineOwnedFacts: async () => ({ playerStatus: "SELF_EXCLUDED", playthroughOutstanding: "0" }) },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.status).toBe(403);
      expect(blocked.error.code).toBe("PLAYER_NOT_ACTIVE");
    }

    const owing = await requestRedemption(
      { sub: USER_ID, email: "redeemer@player.io" },
      { amount: "100.0000", idempotencyKey: "redeem-attempt-playthru" },
      {},
      { engineOwnedFacts: async () => ({ playerStatus: "ACTIVE", playthroughOutstanding: "25.0000" }) },
    );
    expect(owing.ok).toBe(false);
    if (!owing.ok) {
      expect(owing.status).toBe(403);
      expect(owing.error.code).toBe("PLAYTHROUGH_OUTSTANDING");
    }

    // Neither reached the ledger.
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
  });
});

describe("POST /api/store/redeem — success flow (mirrors purchasePackage)", () => {
  beforeEach(() => {
    setEngineHandler((c: EngineCall) =>
      c.path === "/api/v1/store/redeem" ? okRedeem(c.body.operator_transaction_id) : unexpected,
    );
  });

  it("journals the REDEEM intent and anchors it BEFORE dispatching to Zone 1", async () => {
    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(200);

    const journal = getJournal("redeem:redeem-attempt-0001");
    expect(journal).toBeDefined();
    expect(journal?.type).toBe("REDEEM");
    expect(journal?.status).toBe("SUCCEEDED");
    expect(journal?.ledgerTransactionId).toBe("ltx-redeem-ok");
    // The replayable payload is stored verbatim, so the reconciler can re-send these bytes.
    expect(journal?.requestPayload).toMatchObject({
      operator_transaction_id: "redeem:redeem-attempt-0001",
      player_id: PLAYER_ID,
      amount: "100.0000",
    });
  });

  it("debits in Zone 1 at request time, with the amount as a decimal string", async () => {
    await redeem(goodBody());

    const call = engineCalls.find((c) => c.path === "/api/v1/store/redeem");
    expect(call).toBeDefined();
    expect(call?.body.amount).toBe("100.0000");
    expect(typeof call?.body.amount).toBe("string");
    // Zero-trust headers come free from postTx; asserted here so a future refactor that
    // bypassed it would be caught at the route level too.
    expect(call?.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(call?.headers["X-Nonce"]).toBeTruthy();
    expect(call?.headers["X-Timestamp"]).toMatch(/^\d+$/);
  });

  it("records the orchestration row at UNDER_REVIEW with the ledger id, and NO balance", async () => {
    const res = await redeem(goodBody());
    const rows = getRedemptions();
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.status).toBe("UNDER_REVIEW");
    expect(row.amount).toBe("100.0000");
    expect(row.ledgerTransactionId).toBe("ltx-redeem-ok");
    expect(row.operatorTransactionId).toBe("redeem:redeem-attempt-0001");

    // ZERO FINANCIAL STATE: the engine returned post_balances and none of it was kept.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("900.0000");
    expect(serialized).not.toContain("post_balances");
    for (const key of Object.keys(row)) expect(key.toLowerCase()).not.toContain("balance");

    expect(res.json().data).toMatchObject({
      status: "UNDER_REVIEW",
      ledgerTransactionId: "ltx-redeem-ok",
      amount: "100.0000",
    });
    // The response carries no balance either.
    expect(JSON.stringify(res.json().data)).not.toContain("900.0000");
  });
});

describe("POST /api/store/redeem — attempt anchor", () => {
  it("→ 409 ATTEMPT_OWNERSHIP when the anchor belongs to another player", async () => {
    setEngineHandler((c: EngineCall) =>
      c.path === "/api/v1/store/redeem" ? okRedeem(c.body.operator_transaction_id) : unexpected,
    );
    // Another player already owns this attempt token.
    const { seedJournalRow } = await import("./fakes/prisma.fake");
    seedJournalRow({
      operatorTransactionId: "redeem:redeem-attempt-0001",
      type: "REDEEM",
      status: "PENDING",
      playerId: "a-different-player",
    });

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ATTEMPT_OWNERSHIP");
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
  });

  it("→ 409 ATTEMPT_SETTLED when the anchor already succeeded (no second debit)", async () => {
    const { seedJournalRow } = await import("./fakes/prisma.fake");
    seedJournalRow({
      operatorTransactionId: "redeem:redeem-attempt-0001",
      type: "REDEEM",
      status: "SUCCEEDED",
      playerId: PLAYER_ID,
      ledgerTransactionId: "ltx-already",
    });
    setEngineHandler(() => unexpected);

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ATTEMPT_SETTLED");
    expect(engineCalls.find((c) => c.path === "/api/v1/store/redeem")).toBeUndefined();
  });

  it("→ 409 ATTEMPT_EXHAUSTED for an abandoned anchor", async () => {
    const { seedJournalRow } = await import("./fakes/prisma.fake");
    seedJournalRow({
      operatorTransactionId: "redeem:redeem-attempt-0001",
      type: "REDEEM",
      status: "ABANDONED",
      playerId: PLAYER_ID,
    });
    setEngineHandler(() => unexpected);

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ATTEMPT_EXHAUSTED");
  });
});

describe("POST /api/store/redeem — engine refusals", () => {
  it("maps PLAYER_NOT_ACTIVE onto the policy's refusal vocabulary and REJECTS the row", async () => {
    setEngineHandler(() => ({
      ok: false,
      status: 403,
      body: { code: "PLAYER_NOT_ACTIVE", message: "player is not active" },
    }));

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("PLAYER_NOT_ACTIVE");
    expect(res.json().error.details.refusals).toEqual(["PLAYER_NOT_ACTIVE"]);
    // Terminal refusal → the orchestration row is closed out, not left dangling.
    expect(getRedemptions()[0]?.status).toBe("REJECTED");
    expect(getJournal("redeem:redeem-attempt-0001")?.status).toBe("FAILED");
  });

  it("maps PLAYTHROUGH_OUTSTANDING the same way", async () => {
    setEngineHandler(() => ({
      ok: false,
      status: 403,
      body: { code: "PLAYTHROUGH_OUTSTANDING", message: "not yet" },
    }));

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.refusals).toEqual(["PLAYTHROUGH_OUTSTANDING"]);
    expect(getRedemptions()[0]?.status).toBe("REJECTED");
  });

  it("leaves a RETRYABLE failure at REQUESTED and hands it to the reconciler", async () => {
    setEngineHandler(() => ({ ok: false, status: 503, body: { code: "ENGINE_UNAVAILABLE", message: "down" } }));

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(503);
    // NOT rejected: the debit may have committed without us seeing the response, and asserting
    // an outcome we do not know is exactly the ambiguity the journal exists to avoid.
    expect(getRedemptions()[0]?.status).toBe("REQUESTED");
    expect(getJournal("redeem:redeem-attempt-0001")?.status).toBe("FAILED");
    expect(getJournal("redeem:redeem-attempt-0001")?.retryable).toBe(true);
  });

  it("surfaces INSUFFICIENT_FUNDS from the engine rather than pre-judging it", async () => {
    // Zone 2 never checks a balance; this is the engine's answer arriving unaltered.
    setEngineHandler(() => ({
      ok: false,
      status: 400,
      body: { code: "INSUFFICIENT_FUNDS", message: "not enough SC_REDEEMABLE" },
    }));

    const res = await redeem(goodBody());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INSUFFICIENT_FUNDS");
  });
});
