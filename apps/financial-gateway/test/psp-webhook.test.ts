import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace the Prisma singleton with the in-memory fake (shared instance with the helpers).
vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import type { AuthClaims } from "../src/lib/jwt";
import { setPaymentProvider } from "../src/lib/payments";
import { MockPaymentProvider } from "../src/lib/payments/mock";
import { PspWebhookSignatureError } from "../src/lib/payments/types";
import { setReconcileQueue } from "../src/lib/reconcile-queue";
import { handlePspWebhookEvent } from "../src/services/psp-webhook.service";
import { purchasePackage } from "../src/services/store.service";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { getJournal, resetDb, seedJournalRow, seedUser } from "./fakes/prisma.fake";
import { ReconcileQueueFake } from "./fakes/reconcile-queue.fake";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const ENGINE_PLAYER_ID = "engine-player-psp";
const PSP_SECRET = "test_psp_secret";

let psp: MockPaymentProvider;
let queue: ReconcileQueueFake;

function okPurchase(operatorTransactionId: string, ledgerTxId: string): Directive {
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
        transaction_type: "DEPOSIT",
        family: "GC",
        amount: "20000",
        post_balances: { gc: "20000", sc_unplayed: "20", sc_redeemable: "0" },
        status: "PROCESSED",
      },
    },
  };
}

const unexpected: Directive = { ok: false, status: 500, body: { code: "UNEXPECTED" } };

const user: AuthClaims = { sub: USER_ID, email: "buyer@test.io", kycStatus: "VERIFIED", vipLevel: 0 };

/** Seed a PENDING deposit for `$20 Value`, with its PSP intent already opened on `psp`. */
async function seedPendingDeposit(attemptId: string): Promise<{ opTx: string; paymentIntentId: string }> {
  const opTx = `deposit:${attemptId}`;
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
    requestPayload: {
      paymentIntentId: intent.paymentIntentId,
      expectedAmountCents: 2000,
      currency: "USD",
      purchase: {
        operator_transaction_id: opTx,
        player_id: ENGINE_PLAYER_ID,
        gc_amount: "20000",
        sc_promo_amount: "20",
        metadata: { package_id: "pkg_value_20", usd_cents: 2000, purchase_attempt: attemptId },
      },
    },
  });
  return { opTx, paymentIntentId: intent.paymentIntentId };
}

beforeEach(() => {
  resetDb();
  resetEngine();
  psp = new MockPaymentProvider(PSP_SECRET);
  setPaymentProvider(psp);
  queue = new ReconcileQueueFake();
  setReconcileQueue(queue); // producers schedule the lost-webhook backstop here
  seedUser({ id: USER_ID, email: "buyer@test.io", kycStatus: "VERIFIED", trueEnginePlayerId: ENGINE_PLAYER_ID });
});

afterEach(() => {
  setReconcileQueue(null);
});

describe("asynchronous PSP settlement", () => {
  it("Phase 1 — purchase opens a PENDING intent and returns a client_secret WITHOUT capturing or crediting", async () => {
    setEngineHandler(() => unexpected); // the ledger must NOT be called synchronously

    const outcome = await purchasePackage(user, { packageId: "pkg_value_20", idempotencyKey: "buy-1xxx" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("requires_payment_confirmation");
    expect(outcome.data.clientSecret).toBeTruthy();
    expect(outcome.data.operatorTransactionId).toBe("deposit:buy-1xxx");

    // The deposit is journaled PENDING; no engine credit has happened yet.
    expect(getJournal("deposit:buy-1xxx")?.status).toBe("PENDING");
    expect(engineCalls.filter((c) => c.path === "/api/v1/store/purchase")).toHaveLength(0);
  });

  it("Phase 5.3 — a verified payment_intent.succeeded webhook credits the ledger EXACTLY ONCE (idempotent)", async () => {
    const { opTx, paymentIntentId } = await seedPendingDeposit("buy-2xxx");
    psp.markIntentSucceeded(paymentIntentId);

    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/store/purchase" ? okPurchase(call.body.operator_transaction_id, "ltx-psp-2") : unexpected,
    );

    const { rawBody, signature } = psp.buildSignedWebhook(paymentIntentId, "payment_intent.succeeded");

    // First delivery: signature verified → idempotent ledger credit runs.
    const first = await handlePspWebhookEvent(psp.parseWebhook(rawBody, signature));
    expect(first.handled).toBe(true);
    expect(getJournal(opTx)?.status).toBe("SUCCEEDED");
    expect(getJournal(opTx)?.ledgerTransactionId).toBe("ltx-psp-2");

    // Stripe re-delivers webhooks; the SAME event must not double-credit.
    const second = await handlePspWebhookEvent(psp.parseWebhook(rawBody, signature));
    expect(second.handled).toBe(true);
    expect(second.note).toBe("already settled");

    // Empirical proof of exactly-once: a single credit reached the ledger.
    expect(engineCalls.filter((c) => c.path === "/api/v1/store/purchase")).toHaveLength(1);
  });

  it("Task 2 — a settled deposit drops its lost-webhook backstop (ZREM reconcile:scheduled)", async () => {
    // Opening the deposit ARMS the 10-minute backstop on the broker (the ZADD)...
    const opened = await purchasePackage(user, { packageId: "pkg_value_20", idempotencyKey: "buy-zrem" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(queue.scheduledCount).toBe(1); // backstop armed

    psp.markIntentSucceeded(opened.data.paymentIntentId);
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/store/purchase" ? okPurchase(call.body.operator_transaction_id, "ltx-zrem") : unexpected,
    );

    // ...and a verified `succeeded` webhook settles it AND cancels the now-moot backstop.
    const { rawBody, signature } = psp.buildSignedWebhook(opened.data.paymentIntentId, "payment_intent.succeeded");
    const outcome = await handlePspWebhookEvent(psp.parseWebhook(rawBody, signature));

    expect(outcome.handled).toBe(true);
    expect(getJournal(opened.data.operatorTransactionId)?.status).toBe("SUCCEEDED");
    // Backstop dropped — no redundant reconcile event ~10 minutes after a deposit already settled.
    expect(queue.scheduledCount).toBe(0);
  });

  it("Z2-M1-T1 — refuses to CREDIT on a success webhook whose payment_ref is not the journaled intent", async () => {
    const { opTx } = await seedPendingDeposit("buy-refx");
    // A second, unrelated intent captured under the same anchor metadata — a correlation bug
    // (or cross-attempt confusion), never a legitimate settlement of THIS deposit.
    const rogue = await psp.createPaymentIntent({
      amountCents: 2000,
      currency: "USD",
      idempotencyKey: "rogue-key",
      customerRef: USER_ID,
      metadata: { operator_transaction_id: opTx, package_id: "pkg_value_20" },
    });
    psp.markIntentSucceeded(rogue.paymentIntentId);
    setEngineHandler(() => unexpected); // no credit may reach the ledger

    const { rawBody, signature } = psp.buildSignedWebhook(rogue.paymentIntentId, "payment_intent.succeeded");
    const outcome = await handlePspWebhookEvent(psp.parseWebhook(rawBody, signature));

    expect(outcome).toMatchObject({ handled: false, note: "payment_ref mismatch" });
    expect(getJournal(opTx)?.status).toBe("PENDING"); // journal untouched — the real intent may still settle
    expect(engineCalls.filter((c) => c.path === "/api/v1/store/purchase")).toHaveLength(0);
  });

  it("Z2-M1-T1 — refuses to ABANDON on a failure webhook whose payment_ref is not the journaled intent", async () => {
    const { opTx } = await seedPendingDeposit("buy-refy");
    const rogue = await psp.createPaymentIntent({
      amountCents: 2000,
      currency: "USD",
      idempotencyKey: "rogue-key-2",
      customerRef: USER_ID,
      metadata: { operator_transaction_id: opTx, package_id: "pkg_value_20" },
    });
    psp.markIntentFailed(rogue.paymentIntentId);
    setEngineHandler(() => unexpected);

    const { rawBody, signature } = psp.buildSignedWebhook(rogue.paymentIntentId, "payment_intent.payment_failed");
    const outcome = await handlePspWebhookEvent(psp.parseWebhook(rawBody, signature));

    expect(outcome).toMatchObject({ handled: false, note: "payment_ref mismatch" });
    // The deposit stays PENDING — a foreign failure must not kill an attempt whose real
    // capture may still arrive.
    expect(getJournal(opTx)?.status).toBe("PENDING");
  });

  it("rejects a webhook whose HMAC signature does not verify", async () => {
    const { paymentIntentId } = await seedPendingDeposit("buy-3xxx");
    psp.markIntentSucceeded(paymentIntentId);
    const { rawBody } = psp.buildSignedWebhook(paymentIntentId, "payment_intent.succeeded");

    // A forged/incorrect signature must be refused before any handling.
    const forged = "deadbeef".repeat(8); // valid hex, wrong HMAC
    expect(() => psp.parseWebhook(rawBody, forged)).toThrow(PspWebhookSignatureError);

    // ...and nothing was credited.
    expect(engineCalls.filter((c) => c.path === "/api/v1/store/purchase")).toHaveLength(0);
  });

  it("payment_intent.payment_failed marks the deposit terminal and never credits", async () => {
    const { opTx, paymentIntentId } = await seedPendingDeposit("buy-4xxx");
    psp.markIntentFailed(paymentIntentId);
    setEngineHandler(() => unexpected); // no credit on a failed payment

    const { rawBody, signature } = psp.buildSignedWebhook(paymentIntentId, "payment_intent.payment_failed");
    const outcome = await handlePspWebhookEvent(psp.parseWebhook(rawBody, signature));

    expect(outcome.handled).toBe(true);
    expect(getJournal(opTx)?.status).toBe("ABANDONED");
    expect(engineCalls.filter((c) => c.path === "/api/v1/store/purchase")).toHaveLength(0);
  });
});
