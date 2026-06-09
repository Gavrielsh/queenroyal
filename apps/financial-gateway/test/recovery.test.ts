import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace the Prisma singleton with the in-memory fake (shared instance with the helpers).
vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { setPaymentProvider } from "../src/lib/payments";
import { MockPaymentProvider } from "../src/lib/payments/mock";
import { setReconcileQueue } from "../src/lib/reconcile-queue";
import { processProviderSpin } from "../src/services/game-adapter.service";
import { handlePspWebhookEvent } from "../src/services/psp-webhook.service";
import { processReconcileBatch } from "../src/services/reconciliation.service";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { getJournal, resetDb, seedJournalRow, seedUser } from "./fakes/prisma.fake";
import { ReconcileQueueFake } from "./fakes/reconcile-queue.fake";

/** Drain the reconcile broker once (non-blocking) and return the per-message outcomes. */
function drainReconciler(queue: ReconcileQueueFake) {
  return processReconcileBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000, maxAttempts: 5 });
}

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

const PSP_SECRET = "test_psp_secret";
let psp: MockPaymentProvider;
let queue: ReconcileQueueFake;

/** The DEPOSIT credit instruction journaled for the $20 package. */
function depositInstruction(opTx: string, paymentIntentId: string, attemptId: string) {
  return {
    paymentIntentId,
    expectedAmountCents: 2000,
    currency: "USD",
    purchase: {
      operator_transaction_id: opTx,
      player_id: ENGINE_PLAYER_ID,
      gc_amount: "20000",
      sc_promo_amount: "20",
      metadata: { package_id: "pkg_value_20", usd_cents: 2000, purchase_attempt: attemptId },
    },
  };
}

beforeEach(() => {
  resetDb();
  resetEngine();
  psp = new MockPaymentProvider(PSP_SECRET);
  setPaymentProvider(psp);
  queue = new ReconcileQueueFake();
  setReconcileQueue(queue); // producers enqueue here; the reconciler consumes from here
  seedUser({ id: USER_ID, email: "player@test.io", kycStatus: "VERIFIED", trueEnginePlayerId: ENGINE_PLAYER_ID });
});

afterEach(() => {
  setReconcileQueue(null);
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
    // The adapter emitted a reconcile event for the failed bet (event-driven, not polled).
    expect(queue.readyCount).toBe(1);

    // The event-driven reconciler consumes the event and resolves the intent.
    const outcomes = await drainReconciler(queue);
    expect(outcomes).toEqual(["succeeded"]);
    expect(queue.inFlightCount).toBe(0); // acked off the stream

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
    expect(queue.readyCount).toBe(1); // a reconcile event for the orphaned win

    // The reconciler retries the win; it is terminally rejected → it compensates the bet.
    const outcomes = await drainReconciler(queue);
    expect(outcomes).toEqual(["compensated"]);

    const rollback = engineCalls.find((c) => c.path === "/api/v1/rollback");
    expect(rollback).toBeDefined();
    expect(rollback?.body.operator_transaction_id).toBe(`rollback:${ref}`);
    expect(rollback?.body.reference_transaction_id).toBe("ltx-bet-2"); // the bet's ledger_transaction_id
    expect(getJournal(`win:${ref}`)?.status).toBe("COMPENSATED");
    expect(getJournal(`rollback:${ref}`)?.status).toBe("SUCCEEDED");
  });

  it("Scenario 3 — Lost PSP webhook: a captured intent is recovered by the reconciler polling the PSP", async () => {
    const attemptId = "attempt-3";
    const opTx = `deposit:${attemptId}`;

    // (a) The gateway opened the intent and journaled a PENDING deposit (pre-intent outbox)...
    const intent = await psp.createPaymentIntent({
      amountCents: 2000,
      currency: "USD",
      idempotencyKey: attemptId,
      customerRef: USER_ID,
      metadata: { operator_transaction_id: opTx, package_id: "pkg_value_20" },
    });
    seedJournalRow({
      operatorTransactionId: opTx,
      type: "DEPOSIT",
      status: "PENDING",
      playerId: ENGINE_PLAYER_ID,
      providerRef: intent.paymentIntentId,
      requestPayload: depositInstruction(opTx, intent.paymentIntentId, attemptId),
      updatedAt: new Date(Date.now() - 10 * 60_000), // stale (webhook lost 10 min ago)
    });
    // (b) ...the customer confirmed and the PSP captured the card, but the `succeeded`
    //     webhook never reached us (dropped). The PSP's own view says succeeded.
    psp.markIntentSucceeded(intent.paymentIntentId);

    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/store/purchase" ? okTx(call.body.operator_transaction_id, "ltx-dep-3") : unexpected,
    );

    // The lost-webhook backstop fires as a SCHEDULED event (no DB polling): once its deadline
    // elapses it becomes deliverable, and the reconciler polls the PSP, sees the capture, and
    // credits exactly once.
    await queue.schedule({ operatorTransactionId: opTx, reason: "deposit_pending_deadline" }, 0);
    const outcomes = await drainReconciler(queue);
    expect(outcomes).toEqual(["succeeded"]);

    const purchase = engineCalls.find((c) => c.path === "/api/v1/store/purchase");
    expect(purchase).toBeDefined();
    // The captured payment ref is stamped into the ledger metadata for audit.
    expect(purchase?.body.metadata.payment_ref).toBe(intent.paymentIntentId);

    const row = getJournal(opTx);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.ledgerTransactionId).toBe("ltx-dep-3");
  });

  it("Scenario 3b — Webhook credit failure: a captured deposit whose credit drops is re-driven (no re-charge)", async () => {
    const attemptId = "attempt-3b";
    const opTx = `deposit:${attemptId}`;

    const intent = await psp.createPaymentIntent({
      amountCents: 2000,
      currency: "USD",
      idempotencyKey: attemptId,
      customerRef: USER_ID,
      metadata: { operator_transaction_id: opTx, package_id: "pkg_value_20" },
    });
    psp.markIntentSucceeded(intent.paymentIntentId);
    seedJournalRow({
      operatorTransactionId: opTx,
      type: "DEPOSIT",
      status: "PENDING",
      playerId: ENGINE_PLAYER_ID,
      providerRef: intent.paymentIntentId,
      requestPayload: depositInstruction(opTx, intent.paymentIntentId, attemptId),
    });

    let purchaseAttempts = 0;
    setEngineHandler((call: EngineCall) => {
      if (call.path === "/api/v1/store/purchase") {
        purchaseAttempts += 1;
        if (purchaseAttempts === 1) return { throwKind: "network" }; // capture confirmed, credit drops
        return okTx(call.body.operator_transaction_id, "ltx-dep-3b");
      }
      return unexpected;
    });

    // A VERIFIED `succeeded` webhook arrives → the handler attempts the credit, which fails
    // mid-flight → the deposit is left FAILED (capture confirmed, credit pending).
    const wh = psp.buildSignedWebhook(intent.paymentIntentId, "payment_intent.succeeded");
    const handled = await handlePspWebhookEvent(psp.parseWebhook(wh.rawBody, wh.signature));
    expect(handled.handled).toBe(false);
    expect(getJournal(opTx)?.status).toBe("FAILED");
    expect(queue.readyCount).toBe(1); // webhook handler emitted a credit-retry event

    // The reconciler re-drives the CREDIT ONLY (never re-charges the card) → settled once.
    const outcomes = await drainReconciler(queue);
    expect(outcomes).toEqual(["succeeded"]);
    expect(getJournal(opTx)?.status).toBe("SUCCEEDED");

    const purchases = engineCalls.filter((c) => c.path === "/api/v1/store/purchase");
    expect(purchases).toHaveLength(2);
    expect(purchases.every((c) => c.body.operator_transaction_id === opTx)).toBe(true); // same key, no double credit
  });

  it("Scenario 4 — Dead Letter Queue: an intent that exhausts its attempt budget is parked for review", async () => {
    const ref = "spin-poison-4";
    const opTx = `bet:${ref}`;
    // The engine keeps failing with a RETRYABLE error, so the replay never settles.
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/bet"
        ? { ok: false, status: 503, body: { code: "ENGINE_UNREACHABLE", message: "down", trace_id: "t" } }
        : unexpected,
    );
    seedJournalRow({
      operatorTransactionId: opTx,
      type: "BET",
      status: "FAILED",
      retryable: true,
      playerId: ENGINE_PLAYER_ID,
      providerRef: ref,
      requestPayload: {
        operator_transaction_id: opTx,
        player_id: ENGINE_PLAYER_ID,
        currency: "SC",
        amount: "10.0000",
        game_id: "slots",
      },
    });

    await queue.publish({ operatorTransactionId: opTx, reason: "bet_failed_retryable" });
    // maxAttempts:1 → the single attempt is consumed and the intent is ABANDONED.
    const outcomes = await processReconcileBatch({ queue, blockMs: 0, reclaimIdleMs: 60_000, maxAttempts: 1 });

    expect(outcomes).toEqual(["abandoned"]);
    expect(getJournal(opTx)?.status).toBe("ABANDONED");
    // Zero transaction loss: the abandoned intent is quarantined in the DLQ, not dropped.
    expect(queue.dead).toHaveLength(1);
    expect(queue.dead[0]?.message.operatorTransactionId).toBe(opTx);
    expect(queue.inFlightCount).toBe(0);
  });

  it("idempotent consumption: an event for an already-settled intent is a harmless no-op (skipped)", async () => {
    const opTx = "bet:already-done";
    seedJournalRow({
      operatorTransactionId: opTx,
      type: "BET",
      status: "SUCCEEDED",
      ledgerTransactionId: "ltx-done",
      playerId: ENGINE_PLAYER_ID,
      providerRef: "already-done",
    });
    setEngineHandler(() => unexpected); // must never be called

    await queue.publish({ operatorTransactionId: opTx, reason: "duplicate" });
    const outcomes = await drainReconciler(queue);

    expect(outcomes).toEqual(["skipped"]);
    expect(engineCalls).toHaveLength(0); // SKIP LOCKED claim found nothing actionable
    expect(queue.dead).toHaveLength(0);
    expect(queue.inFlightCount).toBe(0); // acked, not requeued
  });

  it("crash recovery: an unacked in-flight message is reclaimed and re-driven", async () => {
    const ref = "spin-reclaim-5";
    const opTx = `bet:${ref}`;
    seedJournalRow({
      operatorTransactionId: opTx,
      type: "BET",
      status: "FAILED",
      retryable: true,
      playerId: ENGINE_PLAYER_ID,
      providerRef: ref,
      requestPayload: {
        operator_transaction_id: opTx,
        player_id: ENGINE_PLAYER_ID,
        currency: "SC",
        amount: "10.0000",
        game_id: "slots",
      },
    });
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/bet" ? okTx(call.body.operator_transaction_id, "ltx-reclaim") : unexpected,
    );

    // Simulate a consumer that pulled the message but crashed before acking.
    await queue.publish({ operatorTransactionId: opTx, reason: "bet_failed_retryable" });
    const [stuck] = await queue.pull(10, 0);
    expect(stuck).toBeDefined();
    expect(queue.inFlightCount).toBe(1);

    // A fresh cycle reclaims the idle in-flight message (minIdleMs:0) and completes it.
    const outcomes = await processReconcileBatch({ queue, blockMs: 0, reclaimIdleMs: 0, maxAttempts: 5 });
    expect(outcomes).toEqual(["succeeded"]);
    expect(getJournal(opTx)?.status).toBe("SUCCEEDED");
    expect(queue.inFlightCount).toBe(0);
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
    expect(bet?.headers["X-Operator-Code"]).toBe("TEST_OP"); // gateway test ENGINE_OPERATOR_CODE
    expect(bet?.headers["X-Signature"]).toMatch(/^[0-9a-f]+$/);
    expect(bet?.headers["X-Timestamp"]).toMatch(/^\d+$/);
    expect(bet?.headers["X-Nonce"]).toBeTruthy();
  });
});
