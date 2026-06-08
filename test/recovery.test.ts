import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the Prisma singleton with the in-memory fake (shared instance with the helpers).
vi.mock("@/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { prisma: mod.prismaFake };
});

import { getJournal, resetDb, seedJournalRow, seedUser } from "./fakes/prisma.fake";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import type { AuthClaims } from "@/lib/jwt";
import { getPaymentProvider } from "@/lib/payments";
import { processProviderSpin } from "@/services/game-adapter.service";
import { reconcileEngineRequests } from "@/services/reconciliation.service";
import { purchasePackage } from "@/services/store.service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ENGINE_PLAYER_ID = "engine-player-1";

/** A successful engine tx envelope ({ code, result }) echoing the call's key. */
function okTx(operatorTransactionId: string, ledgerTxId: string, status = "PROCESSED"): Directive {
  return {
    ok: true,
    status: 200,
    body: {
      code: "OK",
      result: {
        operator_code: "QUEENROYAL",
        operator_transaction_id: operatorTransactionId,
        ledger_transaction_id: ledgerTxId,
        player_id: ENGINE_PLAYER_ID,
        transaction_type: "TX",
        family: "SC",
        amount: "0",
        post_balances: { gc: "0", sc_unplayed: "0", sc_redeemable: "0" },
        status,
      },
    },
  };
}

const unexpected: Directive = { ok: false, status: 500, body: { code: "UNEXPECTED" } };

beforeEach(() => {
  resetDb();
  resetEngine();
  seedUser({ id: USER_ID, email: "player@test.io", kycStatus: "VERIFIED", trueEnginePlayerId: ENGINE_PLAYER_ID });
});

describe("crash & recovery", () => {
  it("Scenario 1 — Ghost Spin: the bet is replayed with the SAME key and resolves", async () => {
    const ref = "spin-ghost-1";
    let betAttempts = 0;
    setEngineHandler((call: EngineCall) => {
      if (call.path === "/api/v1/bet") {
        betAttempts += 1;
        // The engine commits, but the 200 OK is lost in transit on the first try.
        if (betAttempts === 1) return { throwKind: "timeout" };
        // On replay the engine recognizes the duplicate and replays its result.
        return okTx(call.body.operator_transaction_id, "ltx-bet-1", "GHOST_RECOVERED");
      }
      return unexpected;
    });

    // Live spin: the bet "ghosts" → the gateway records a retryable FAILED bet intent.
    const live = await processProviderSpin("PRAGMATIC", {
      provider_transaction_id: ref,
      player_id: USER_ID,
      game_id: "slots",
      currency: "SC",
      bet_amount: "10.0000",
      win_amount: "0",
    });
    expect(live.ok).toBe(false);
    expect(getJournal(`bet:${ref}`)?.status).toBe("FAILED");

    // Reconciler resolves it.
    const summary = await reconcileEngineRequests({ staleAfterMs: 0, maxAttempts: 5 });
    expect(summary.succeeded).toBe(1);

    const betCalls = engineCalls.filter((c) => c.path === "/api/v1/bet");
    expect(betCalls).toHaveLength(2);
    // Proof of safe retry: both attempts used the identical deterministic key.
    expect(betCalls[0]?.body.operator_transaction_id).toBe(`bet:${ref}`);
    expect(betCalls[1]?.body.operator_transaction_id).toBe(`bet:${ref}`);

    const row = getJournal(`bet:${ref}`);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.ledgerTransactionId).toBe("ltx-bet-1");
  });

  it("Scenario 2 — Orphaned Debit: a terminal win failure rolls back the bet (COMPENSATED)", async () => {
    const ref = "spin-orphan-2";
    setEngineHandler((call: EngineCall) => {
      if (call.path === "/api/v1/bet") return okTx(call.body.operator_transaction_id, "ltx-bet-2");
      if (call.path === "/api/v1/win") {
        return { ok: false, status: 400, body: { code: "INSUFFICIENT_FUNDS", message: "insufficient funds", trace_id: "t1" } };
      }
      if (call.path === "/api/v1/rollback") return okTx(call.body.operator_transaction_id, "ltx-rb-2");
      return unexpected;
    });

    // Live spin: bet commits, win is terminally rejected.
    const live = await processProviderSpin("PRAGMATIC", {
      provider_transaction_id: ref,
      player_id: USER_ID,
      game_id: "slots",
      currency: "SC",
      bet_amount: "10.0000",
      win_amount: "50.0000",
    });
    expect(live.ok).toBe(false);
    expect(getJournal(`bet:${ref}`)?.status).toBe("SUCCEEDED");
    expect(getJournal(`win:${ref}`)?.status).toBe("FAILED");

    // Reconciler compensates by rolling back the bet's ledger transaction.
    const summary = await reconcileEngineRequests({ staleAfterMs: 0, maxAttempts: 5 });
    expect(summary.compensated).toBe(1);

    const rollback = engineCalls.find((c) => c.path === "/api/v1/rollback");
    expect(rollback).toBeDefined();
    expect(rollback?.body.operator_transaction_id).toBe(`rollback:${ref}`);
    expect(rollback?.body.reference_transaction_id).toBe("ltx-bet-2"); // the bet's ledger_transaction_id
    expect(getJournal(`win:${ref}`)?.status).toBe("COMPENSATED");
    expect(getJournal(`rollback:${ref}`)?.status).toBe("SUCCEEDED");
  });

  it("Scenario 3 — PSP Crash: a captured charge with only a PENDING intent is settled", async () => {
    const attemptId = "attempt-3";
    const opTx = `deposit:${attemptId}`;
    const instruction = {
      charge: {
        amountCents: 2000,
        currency: "USD",
        paymentMethodToken: "tok_ok",
        idempotencyKey: attemptId,
        customerRef: USER_ID,
        metadata: { operator_transaction_id: opTx, package_id: "pkg_value_20" },
      },
      purchase: {
        operator_transaction_id: opTx,
        player_id: ENGINE_PLAYER_ID,
        gc_amount: "20000",
        sc_promo_amount: "20",
        metadata: { package_id: "pkg_value_20", usd_cents: 2000, purchase_attempt: attemptId },
      },
    };

    // (a) The gateway wrote a PENDING intent BEFORE charging (pre-charge outbox)...
    seedJournalRow({
      operatorTransactionId: opTx,
      type: "DEPOSIT",
      status: "PENDING",
      playerId: ENGINE_PLAYER_ID,
      providerRef: attemptId,
      requestPayload: instruction,
      updatedAt: new Date(Date.now() - 10 * 60_000), // stale (process died 10 min ago)
    });
    // (b) ...the PSP captured the card (same idempotency key the reconciler will reuse)...
    const captured = await getPaymentProvider().charge({
      amountCents: 2000,
      currency: "USD",
      paymentMethodToken: "tok_ok",
      idempotencyKey: attemptId,
      customerRef: USER_ID,
      metadata: { operator_transaction_id: opTx },
    });
    expect(captured.status).toBe("succeeded");
    // (c) ...then the process crashed before the ledger credit (no completion recorded).

    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/store/purchase" ? okTx(call.body.operator_transaction_id, "ltx-dep-3") : unexpected,
    );

    const summary = await reconcileEngineRequests({ staleAfterMs: 1000, maxAttempts: 5 });
    expect(summary.succeeded).toBe(1);

    const purchase = engineCalls.find((c) => c.path === "/api/v1/store/purchase");
    expect(purchase).toBeDefined();
    // Re-capture returned the SAME PaymentIntent → the card was never double-charged.
    expect(purchase?.body.metadata.payment_ref).toBe(captured.paymentIntentId);

    const row = getJournal(opTx);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.ledgerTransactionId).toBe("ltx-dep-3");
  });

  it("Scenario 3b — Orphaned Capture (live flow): ledger failure leaves a FAILED intent the reconciler settles", async () => {
    const attemptId = "attempt-3b";
    const opTx = `deposit:${attemptId}`;
    let purchaseAttempts = 0;
    setEngineHandler((call: EngineCall) => {
      if (call.path === "/api/v1/store/purchase") {
        purchaseAttempts += 1;
        if (purchaseAttempts === 1) return { throwKind: "network" }; // captured, but credit drops
        return okTx(call.body.operator_transaction_id, "ltx-dep-3b");
      }
      return unexpected;
    });

    const user: AuthClaims = { sub: USER_ID, email: "player@test.io", kycStatus: "VERIFIED", vipLevel: 0 };
    const live = await purchasePackage(user, { packageId: "pkg_value_20", paymentToken: "tok_ok", idempotencyKey: attemptId });
    expect(live.ok).toBe(false);
    // Pre-charge outbox => the captured purchase is durably recorded (not orphaned).
    expect(getJournal(opTx)?.status).toBe("FAILED");

    const summary = await reconcileEngineRequests({ staleAfterMs: 0, maxAttempts: 5 });
    expect(summary.succeeded).toBe(1);
    expect(getJournal(opTx)?.status).toBe("SUCCEEDED");

    const purchases = engineCalls.filter((c) => c.path === "/api/v1/store/purchase");
    expect(purchases.every((c) => c.body.operator_transaction_id === opTx)).toBe(true); // same key, no double credit
  });

  it("outbound engine calls carry the four zero-trust headers", async () => {
    const ref = "headers-1";
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/bet" ? okTx(call.body.operator_transaction_id, "ltx-h") : unexpected,
    );
    await processProviderSpin("PRAGMATIC", {
      provider_transaction_id: ref,
      player_id: USER_ID,
      game_id: "g",
      currency: "GC",
      bet_amount: "1",
      win_amount: "0",
    });
    const bet = engineCalls.find((c) => c.path === "/api/v1/bet");
    expect(bet?.headers["X-Operator-Code"]).toBe("QUEENROYAL");
    expect(bet?.headers["X-Signature"]).toMatch(/^[0-9a-f]+$/);
    expect(bet?.headers["X-Timestamp"]).toMatch(/^\d+$/);
    expect(bet?.headers["X-Nonce"]).toBeTruthy();
  });
});
