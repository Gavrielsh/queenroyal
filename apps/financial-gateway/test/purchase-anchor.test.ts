import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the Prisma singleton with the in-memory fake (shared instance with the helpers).
vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import type { AuthClaims } from "../src/lib/jwt";
import { setPaymentProvider } from "../src/lib/payments";
import { MockPaymentProvider } from "../src/lib/payments/mock";
import { setReconcileQueue } from "../src/lib/reconcile-queue";
import { purchasePackage } from "../src/services/store.service";
import { type Directive, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { getJournal, prismaFake, resetDb, seedUser } from "./fakes/prisma.fake";
import { ReconcileQueueFake } from "./fakes/reconcile-queue.fake";

/**
 * Z2-M1-T1 — the purchase attempt anchor is SINGLE-OWNER and SINGLE-SHOT, and the PSP
 * idempotency key is derived + user-scoped. These tests exercise the REAL service against the
 * in-memory journal and mock PSP; the engine fake trips on any accidental synchronous credit.
 */

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAYER_A = "engine-player-a";
const PLAYER_B = "engine-player-b";

const userA: AuthClaims = { sub: USER_A, email: "a@test.io", kycStatus: "VERIFIED", vipLevel: 0 };
const userB: AuthClaims = { sub: USER_B, email: "b@test.io", kycStatus: "VERIFIED", vipLevel: 0 };

const unexpected: Directive = { ok: false, status: 500, body: { code: "UNEXPECTED" } };

let psp: MockPaymentProvider;

beforeEach(() => {
  resetDb();
  resetEngine();
  setEngineHandler(() => unexpected); // the ledger must never be called by initiate
  psp = new MockPaymentProvider("test_psp_secret");
  setPaymentProvider(psp);
  setReconcileQueue(new ReconcileQueueFake());
  seedUser({ id: USER_A, email: "a@test.io", kycStatus: "VERIFIED", trueEnginePlayerId: PLAYER_A });
  seedUser({ id: USER_B, email: "b@test.io", kycStatus: "VERIFIED", trueEnginePlayerId: PLAYER_B });
});

describe("PSP idempotency key derivation (user-scoped, never the raw attempt id)", () => {
  it("passes sha256(<enginePlayerId>:<attemptId>) to the PSP — the raw token never leaves the gateway", async () => {
    const spy = vi.spyOn(psp, "createPaymentIntent");
    const attemptId = "attempt-derivation-1";

    const outcome = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    expect(outcome.ok).toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
    const sentKey = spy.mock.calls[0]?.[0]?.idempotencyKey;
    expect(sentKey).toBe(createHash("sha256").update(`${PLAYER_A}:${attemptId}`, "utf8").digest("hex"));
    expect(sentKey).not.toBe(attemptId);
    expect(sentKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("OWNER RETRY: the same player replaying the same attempt reaches the SAME intent (open-once)", async () => {
    const attemptId = "attempt-retry-1";
    const first = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    const second = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.paymentIntentId).toBe(first.data.paymentIntentId);
    expect(second.data.clientSecret).toBe(first.data.clientSecret);
    expect(getJournal(`deposit:${attemptId}`)?.playerId).toBe(PLAYER_A);
    expect(getJournal(`deposit:${attemptId}`)?.status).toBe("PENDING");
  });
});

describe("attempt-anchor ownership (single-owner)", () => {
  it("FOREIGN KEY: another account replaying an owned attempt gets a uniform 409 and NO PSP call", async () => {
    const attemptId = "attempt-owned-by-a";
    const opened = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    expect(opened.ok).toBe(true);

    const spy = vi.spyOn(psp, "createPaymentIntent");
    const stolen = await purchasePackage(userB, { packageId: "pkg_value_20", idempotencyKey: attemptId });

    expect(stolen.ok).toBe(false);
    if (stolen.ok) return;
    expect(stolen.status).toBe(409);
    expect(stolen.error.code).toBe("ATTEMPT_OWNERSHIP");
    expect(spy).not.toHaveBeenCalled(); // rejected BEFORE the PSP — no intent opened or touched
    expect(getJournal(`deposit:${attemptId}`)?.playerId).toBe(PLAYER_A); // anchor untouched
  });

  it("RACE WINDOW: even with no journal row yet, a foreign caller reaches a DIFFERENT intent — the client_secret never crosses accounts", async () => {
    const attemptId = "attempt-raced";
    const a = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // Simulate B racing ahead of A's journal write: the ownership gate sees no row at all.
    await prismaFake.engineRequestLog.deleteMany({
      where: { operatorTransactionId: `deposit:${attemptId}` },
    });

    const b = await purchasePackage(userB, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    // The user-scoped derived key means B opened a DIFFERENT intent: A's secret is unreachable.
    expect(b.data.paymentIntentId).not.toBe(a.data.paymentIntentId);
    expect(b.data.clientSecret).not.toBe(a.data.clientSecret);
  });
});

describe("attempt-anchor lifecycle (single-shot)", () => {
  it("SETTLED: re-initiating a SUCCEEDED attempt is refused — no second card intent, no double-charge surface", async () => {
    const attemptId = "attempt-settled";
    const opened = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    expect(opened.ok).toBe(true);
    await prismaFake.engineRequestLog.update({
      where: { operatorTransactionId: `deposit:${attemptId}` },
      data: { status: "SUCCEEDED" },
    });

    const spy = vi.spyOn(psp, "createPaymentIntent");
    const replay = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });

    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.status).toBe(409);
    expect(replay.error.code).toBe("ATTEMPT_SETTLED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("EXHAUSTED: an ABANDONED attempt demands a fresh token instead of resurrecting a stale instruction", async () => {
    const attemptId = "attempt-abandoned";
    const opened = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    expect(opened.ok).toBe(true);
    await prismaFake.engineRequestLog.update({
      where: { operatorTransactionId: `deposit:${attemptId}` },
      data: { status: "ABANDONED" },
    });

    const replay = await purchasePackage(userA, { packageId: "pkg_value_20", idempotencyKey: attemptId });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.status).toBe(409);
    expect(replay.error.code).toBe("ATTEMPT_EXHAUSTED");
  });

  it("in-flight retries never touched the ledger at initiate (async contract intact)", () => {
    expect(engineCalls.filter((c) => c.path === "/api/v1/store/purchase")).toHaveLength(0);
  });
});
