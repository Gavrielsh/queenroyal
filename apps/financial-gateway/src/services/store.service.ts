import { randomUUID } from "node:crypto";

import { getPackage } from "../config/store-packages";
import { getEnv } from "../config/env";
import type { FlowContext } from "../lib/context";
import type { AuthClaims } from "../lib/jwt";
import { assertKycAllows, KycGateError } from "../lib/kyc-policy";
import { childLogger } from "../lib/logger";
import { wholeCoinsToMoneyString } from "../lib/money";
import { getPaymentProvider } from "../lib/payments";
import { MockPaymentProvider } from "../lib/payments/mock";
import { PaymentProviderError } from "../lib/payments/types";
import { getPrisma } from "../lib/prisma";
import { scheduleReconcile } from "../lib/reconcile-queue";
import type { DepositInstruction } from "../schemas/engine-payloads.schema";
import type { MockConfirmInput, PurchaseInput } from "../schemas/store.schema";
import { openDepositIntent } from "./deposit.service";
import { beginEngineRequest } from "./engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "./player-provisioning.service";
import { handlePspWebhookEvent } from "./psp-webhook.service";
import type { PurchasePayload, TrueEngineErrorBody } from "../types/true-engine";

export interface PurchaseInitiated {
  /** The frontend must confirm the card with `clientSecret`; settlement is async. */
  status: "requires_payment_confirmation";
  paymentIntentId: string;
  clientSecret: string;
  operatorTransactionId: string;
  package: {
    id: string;
    label: string;
    gc: number;
    sc: number;
    priceUsdCents: number;
  };
}

export type PurchaseOutcome =
  | { ok: true; data: PurchaseInitiated }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * Cashier flow — ASYNCHRONOUS. The route does NOT wait for capture:
 *   validate package → KYC gate → open a PSP PaymentIntent (no capture) → journal a PENDING
 *   DEPOSIT intent (with the full, replayable ledger-credit instruction) → return the intent's
 *   `client_secret`.
 *
 * The frontend confirms the card (and completes any 3DS/SCA) with the `client_secret`.
 * Settlement happens later, exactly once, when the PSP fires a verified
 * `payment_intent.succeeded` webhook (see psp-webhook.service), which drives the idempotent
 * ledger credit. A lost webhook is recovered by the reconciler polling the PSP.
 *
 * Crash safety: opening an intent captures NO money — a capture can only follow the customer
 * confirming with the `client_secret`, which we return only AFTER the intent is journaled. So
 * no confirmed capture can exist without a durable journal row to settle it.
 *
 * The stable anchor is a per-attempt id (the client idempotency key when supplied, else a
 * generated UUID). The PSP intent keys on it (open-once) and the ledger credit's
 * `operator_transaction_id` is `deposit:<attemptId>`.
 */
export async function purchasePackage(
  user: AuthClaims,
  input: PurchaseInput,
  ctx: FlowContext = {},
): Promise<PurchaseOutcome> {
  const flowLog = childLogger({ trace_id: ctx.traceId, user_id: user.sub, package_id: input.packageId });

  const pkg = getPackage(input.packageId);
  if (!pkg) {
    return {
      ok: false,
      status: 404,
      error: { code: "UNKNOWN_PACKAGE", message: `No store package with id '${input.packageId}'` },
    };
  }

  // Identity bridge + current KYC status (single DB read; lazy provisioning).
  let player;
  try {
    player = await resolveTransactingPlayer(user.sub);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned in the ledger", details: err.message },
      };
    }
    throw err;
  }

  // Server-side KYC gate (real-money entry point) — never trust the JWT claim.
  try {
    assertKycAllows(player.kycStatus, "PURCHASE");
  } catch (err) {
    if (err instanceof KycGateError) {
      flowLog.warn({ kyc_status: player.kycStatus, err_code: err.code }, "purchase rejected: KYC gate");
      return { ok: false, status: 403, error: { code: err.code, message: err.message } };
    }
    throw err;
  }

  const playerId = player.trueEnginePlayerId;
  const attemptId = input.idempotencyKey ?? randomUUID();
  const operatorTransactionId = `deposit:${attemptId}`;

  const scPromo = pkg.sc > 0 ? wholeCoinsToMoneyString(pkg.sc) : undefined;
  const purchase: PurchasePayload = {
    operator_transaction_id: operatorTransactionId,
    player_id: playerId,
    gc_amount: wholeCoinsToMoneyString(pkg.gc),
    ...(scPromo ? { sc_promo_amount: scPromo } : {}),
    metadata: { package_id: pkg.id, usd_cents: pkg.priceUsdCents, purchase_attempt: attemptId },
  };

  // Open the PSP PaymentIntent (idempotent on attemptId). Captures NOTHING — the frontend
  // confirms the card next, and a verified `succeeded` webhook later drives the credit.
  let intent;
  try {
    intent = await openDepositIntent({
      amountCents: pkg.priceUsdCents,
      currency: "USD",
      idempotencyKey: attemptId,
      customerRef: user.sub,
      // Echoed back on the PSP webhook so async settlement can find this deposit intent.
      metadata: { operator_transaction_id: operatorTransactionId, package_id: pkg.id },
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      flowLog.error({ operator_transaction_id: operatorTransactionId, err_code: err.code }, "failed to open PSP intent");
      return {
        ok: false,
        status: 503,
        error: { code: err.code, message: "Payment provider is unavailable", details: err.message },
      };
    }
    throw err;
  }

  // Journal the PENDING deposit with the full, replayable credit instruction. This row exists
  // before the `client_secret` is returned, so any later capture is recoverable.
  const instruction: DepositInstruction = {
    paymentIntentId: intent.paymentIntentId,
    expectedAmountCents: pkg.priceUsdCents,
    currency: "USD",
    purchase,
  };
  await beginEngineRequest({
    operatorTransactionId,
    type: "DEPOSIT",
    playerId,
    providerRef: intent.paymentIntentId,
    requestPayload: instruction,
  });

  // Lost-webhook backstop WITHOUT polling Postgres: schedule a delayed reconcile event. If the
  // `succeeded` webhook arrives first it settles the intent and this event becomes a harmless
  // no-op (the row is already terminal). If the webhook is lost, the event fires after the
  // deadline and the reconciler polls the PSP directly.
  await scheduleReconcile(
    { operatorTransactionId, reason: "deposit_pending_deadline" },
    getEnv().RECONCILE_STALE_AFTER_MS,
  );

  flowLog.info(
    { operator_transaction_id: operatorTransactionId, payment_ref: intent.paymentIntentId },
    "deposit intent opened (awaiting PSP confirmation)",
  );

  return {
    ok: true,
    data: {
      status: "requires_payment_confirmation",
      paymentIntentId: intent.paymentIntentId,
      clientSecret: intent.clientSecret,
      operatorTransactionId,
      package: {
        id: pkg.id,
        label: pkg.label,
        gc: pkg.gc,
        sc: pkg.sc,
        priceUsdCents: pkg.priceUsdCents,
      },
    },
  };
}

export interface MockDepositSettled {
  status: "settled";
  paymentIntentId: string;
  operatorTransactionId: string;
  note: string;
}

export type MockConfirmOutcome =
  | { ok: true; data: MockDepositSettled }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * DEV-ONLY cashier helper: stands in for the customer confirming the card AND the PSP firing
 * `payment_intent.succeeded`, in one authenticated call.
 *
 * With the real Stripe provider the frontend confirms via Stripe.js with the `client_secret`
 * and Stripe delivers the webhook; the mock provider has no card UI, so this advances the
 * mock intent and pushes the resulting SIGNED webhook through the exact same verification +
 * settlement seam (`parseWebhook` → `handlePspWebhookEvent`). No alternative credit path is
 * introduced — the ledger credit remains the single idempotent webhook settlement.
 *
 * Refuses to run against a real PSP (409). The mock provider is itself forbidden in
 * production (see lib/payments), so this can never mint coins against real money.
 */
export async function confirmMockDeposit(
  user: AuthClaims,
  input: MockConfirmInput,
  ctx: FlowContext = {},
): Promise<MockConfirmOutcome> {
  const flowLog = childLogger({ trace_id: ctx.traceId, user_id: user.sub, payment_intent_id: input.paymentIntentId });

  const provider = getPaymentProvider();
  if (!(provider instanceof MockPaymentProvider)) {
    return {
      ok: false,
      status: 409,
      error: { code: "MOCK_PSP_ONLY", message: "Mock confirmation is only available with the mock payment provider" },
    };
  }

  const notFound: MockConfirmOutcome = {
    ok: false,
    status: 404,
    error: { code: "INTENT_NOT_FOUND", message: "No such payment intent" },
  };

  const snapshot = await provider.retrievePaymentIntent(input.paymentIntentId);
  if (!snapshot) return notFound;

  const operatorTransactionId = snapshot.metadata.operator_transaction_id;
  if (!operatorTransactionId) return notFound;

  // Ownership gate: only the player who opened the deposit may settle it (mirrors Stripe,
  // where only the holder of the client_secret can confirm the intent).
  let player;
  try {
    player = await resolveTransactingPlayer(user.sub);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned in the ledger", details: err.message },
      };
    }
    throw err;
  }
  const row = await getPrisma().engineRequestLog.findUnique({ where: { operatorTransactionId } });
  // A foreign intent id gets the same 404 as a missing one, so it leaks nothing.
  if (!row || row.type !== "DEPOSIT" || row.playerId !== player.trueEnginePlayerId) return notFound;

  provider.markIntentSucceeded(input.paymentIntentId);
  const { rawBody, signature } = provider.buildSignedWebhook(input.paymentIntentId, "payment_intent.succeeded");
  const event = provider.parseWebhook(rawBody, signature);

  const outcome = await handlePspWebhookEvent(event, ctx.traceId);
  if (!outcome.handled) {
    // Capture is already "succeeded" at the mock PSP; the webhook handler has journaled the
    // failure and handed the credit to the reconciler — surface that honestly.
    flowLog.error({ note: outcome.note }, "mock deposit confirmed but settlement did not complete");
    return {
      ok: false,
      status: 502,
      error: { code: "SETTLEMENT_FAILED", message: "Capture succeeded but the ledger credit did not settle", details: outcome.note },
    };
  }

  flowLog.info({ operator_transaction_id: operatorTransactionId, note: outcome.note }, "mock deposit settled");
  return {
    ok: true,
    data: { status: "settled", paymentIntentId: input.paymentIntentId, operatorTransactionId, note: outcome.note },
  };
}
