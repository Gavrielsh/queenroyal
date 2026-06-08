import { getPaymentProvider } from "@/lib/payments";
import type { CreateIntentRequest, PaymentIntentResult, PaymentIntentSnapshot } from "@/lib/payments/types";
import { trueEngine } from "@/lib/true-engine";
import type { DepositInstruction } from "@/schemas/engine-payloads.schema";
import type { EngineTxResult, PurchasePayload, TrueEngineResult } from "@/types/true-engine";

export type { DepositInstruction } from "@/schemas/engine-payloads.schema";

/**
 * Cashier ↔ ledger glue for the ASYNCHRONOUS deposit flow. Nothing here captures money:
 *   - `openDepositIntent` opens the PSP PaymentIntent and returns a `client_secret`.
 *   - `creditConfirmedDeposit` runs the (idempotent) ledger credit AFTER a verified
 *     `succeeded` event — it stamps the captured `payment_ref` into the ledger metadata
 *     for audit. Safe to call any number of times: the engine de-duplicates on
 *     `purchase.operator_transaction_id`.
 *   - `pollDepositIntent` reads the intent's current state straight from the PSP, the
 *     reconciler's backstop for a lost webhook.
 */

/** Open a PSP intent (no capture). Returns the `client_secret` for the frontend. */
export async function openDepositIntent(req: CreateIntentRequest): Promise<PaymentIntentResult> {
  return getPaymentProvider().createPaymentIntent(req);
}

/** Read an intent's current state from the PSP (reconciler lost-webhook backstop). */
export async function pollDepositIntent(paymentIntentId: string): Promise<PaymentIntentSnapshot | null> {
  return getPaymentProvider().retrievePaymentIntent(paymentIntentId);
}

/**
 * Credit the ledger for a deposit whose PSP capture is CONFIRMED. Idempotent on
 * `purchase.operator_transaction_id` (the engine returns CACHED/GHOST_RECOVERED on a
 * replay), so the webhook handler and the reconciler can both drive it without ever
 * double-crediting.
 */
export async function creditConfirmedDeposit(
  instruction: DepositInstruction,
): Promise<TrueEngineResult<EngineTxResult>> {
  const purchase: PurchasePayload = {
    ...instruction.purchase,
    metadata: { ...(instruction.purchase.metadata ?? {}), payment_ref: instruction.paymentIntentId },
  };
  return trueEngine().sendPurchase(purchase);
}
