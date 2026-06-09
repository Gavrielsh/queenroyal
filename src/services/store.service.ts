import { randomUUID } from "node:crypto";

import { getPackage } from "@/config/store-packages";
import type { FlowContext } from "@/lib/context";
import { assertKycAllows, KycGateError } from "@/lib/kyc-policy";
import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { wholeCoinsToMoneyString } from "@/lib/money";
import type { AuthClaims } from "@/lib/jwt";
import { PaymentProviderError } from "@/lib/payments/types";
import { scheduleReconcile } from "@/lib/reconcile-queue";
import type { DepositInstruction } from "@/schemas/engine-payloads.schema";
import type { PurchaseInput } from "@/schemas/store.schema";
import { openDepositIntent } from "@/services/deposit.service";
import { beginEngineRequest } from "@/services/engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "@/services/player-provisioning.service";
import type { PurchasePayload, TrueEngineErrorBody } from "@/types/true-engine";

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
 *   validate package → KYC gate → open a PSP PaymentIntent (no capture) → journal a
 *   PENDING DEPOSIT intent (with the full, replayable ledger-credit instruction) → return
 *   the intent's `client_secret`.
 *
 * The frontend confirms the card (and completes any 3DS/SCA) with the `client_secret`.
 * Settlement happens later, exactly once, when the PSP fires a verified
 * `payment_intent.succeeded` webhook (see psp-webhook.service), which drives the
 * idempotent ledger credit. A lost webhook is recovered by the reconciler polling the PSP.
 *
 * Crash safety: opening an intent captures NO money — a capture can only follow the
 * customer confirming with the `client_secret`, which we return only AFTER the intent is
 * journaled. So no confirmed capture can exist without a durable journal row to settle it.
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

  // Journal the PENDING deposit with the full, replayable credit instruction. This row
  // exists before the `client_secret` is returned, so any later capture is recoverable.
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

  // Lost-webhook backstop WITHOUT polling Postgres: schedule a delayed reconcile event. If
  // the `succeeded` webhook arrives first it settles the intent and this event becomes a
  // harmless no-op (the row is already terminal). If the webhook is lost, the event fires
  // after the deadline and the reconciler polls the PSP directly.
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
