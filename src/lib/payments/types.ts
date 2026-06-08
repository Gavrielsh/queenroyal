/**
 * Payment Service Provider (PSP) abstraction. The cashier depends on this interface, not
 * on any concrete SDK, so a real Stripe (or Adyen/Braintree) implementation drops in
 * without touching the ledger flow. The data structures are shaped to carry real PSP
 * idempotency keys and to normalize real PSP webhook events for async settlement.
 */

/** A charge/capture request. `idempotencyKey` maps to the PSP's Idempotency-Key header. */
export interface ChargeRequest {
  /** Integer minor units (cents) — correct at the PSP boundary only. */
  amountCents: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** PSP payment-method / token id (e.g. a Stripe PaymentMethod "pm_..."/ test token). */
  paymentMethodToken: string;
  /** Stable per-attempt key; replaying with the same key must NOT double-charge. */
  idempotencyKey: string;
  /** Our user id, forwarded to the PSP as the customer reference. */
  customerRef: string;
  /**
   * Small, string-valued metadata echoed back on the PSP webhook so async settlement can
   * correlate the event to our deposit intent (notably `operator_transaction_id`).
   */
  metadata?: Record<string, string>;
}

/** Terminal-ish charge states. `requires_action` covers 3DS/SCA async confirmation. */
export type ChargeStatus = "succeeded" | "requires_action" | "failed";

export interface ChargeResult {
  status: ChargeStatus;
  /** PSP PaymentIntent id — our `payment_ref` for the ledger and reconciliation. */
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  /** Present when status === "failed". */
  declineReason?: string;
  /** Present when status === "requires_action" — the frontend completes SCA with it. */
  clientSecret?: string;
}

/** A normalized, signature-verified PSP webhook event (async settlement path). */
export interface PspWebhookEvent {
  id: string;
  /** Provider-native type, e.g. "payment_intent.succeeded" / "payment_intent.payment_failed". */
  type: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  status: ChargeStatus;
  /** The metadata we attached at charge time (carries `operator_transaction_id`). */
  metadata: Record<string, string>;
}

export class PaymentProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

/** Thrown by a provider that is selected but not fully wired (e.g. missing SDK/keys). */
export class PaymentProviderNotConfiguredError extends PaymentProviderError {
  constructor(message: string) {
    super("PSP_NOT_CONFIGURED", message);
    this.name = "PaymentProviderNotConfiguredError";
  }
}

/** Thrown when a PSP webhook signature fails verification. */
export class PspWebhookSignatureError extends PaymentProviderError {
  constructor(message = "invalid PSP webhook signature") {
    super("PSP_WEBHOOK_BAD_SIGNATURE", message);
    this.name = "PspWebhookSignatureError";
  }
}

export interface PaymentProvider {
  readonly name: string;
  /** Capture (or idempotently confirm a prior capture of) a charge. */
  charge(req: ChargeRequest): Promise<ChargeResult>;
  /**
   * Verify a PSP webhook's signature over the RAW body and parse it into a normalized
   * event. Throws {@link PspWebhookSignatureError} on a bad/absent signature.
   */
  parseWebhook(rawBody: string, signatureHeader: string): PspWebhookEvent;
}
