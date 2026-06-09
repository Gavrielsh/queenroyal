/**
 * Payment Service Provider (PSP) abstraction. The cashier depends on this interface, not on
 * any concrete SDK, so a real Stripe (or Adyen/Braintree) implementation drops in without
 * touching the ledger flow.
 *
 * The model is ASYNCHRONOUS and event-driven, mirroring how real PSPs actually behave (3D
 * Secure, delayed capture, chargebacks). The gateway NEVER assumes a synchronous capture:
 *   1. `createPaymentIntent` registers the intent and returns a `client_secret` the frontend
 *      uses to confirm the card (and complete SCA/3DS). No funds move yet.
 *   2. The PSP fires a signed webhook (`payment_intent.succeeded` /
 *      `payment_intent.payment_failed`) once the customer completes the flow. ONLY a verified
 *      `succeeded` event drives the ledger credit.
 *   3. `retrievePaymentIntent` lets the reconciler poll the PSP as a backstop for a lost
 *      webhook, so a captured charge can never be orphaned.
 */

/** A request to OPEN a payment intent. Returns a `client_secret`; it does NOT capture. */
export interface CreateIntentRequest {
  /** Integer minor units (cents) — correct at the PSP boundary only. */
  amountCents: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Stable per-attempt key; replaying with the same key returns the SAME intent. */
  idempotencyKey: string;
  /** Our user id, forwarded to the PSP as the customer reference. */
  customerRef: string;
  /**
   * Small, string-valued metadata echoed back on the PSP webhook so async settlement can
   * correlate the event to our deposit intent (notably `operator_transaction_id`).
   */
  metadata?: Record<string, string>;
}

/**
 * PaymentIntent lifecycle states (a superset of Stripe's). The webhook/poll path only acts on
 * the terminal `succeeded` / `failed` (and `canceled`).
 */
export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "canceled"
  | "failed";

/** Result of opening an intent. The `clientSecret` is returned to the frontend. */
export interface PaymentIntentResult {
  /** PSP PaymentIntent id — our `payment_ref` for the ledger and reconciliation. */
  paymentIntentId: string;
  /** Opaque secret the frontend uses to confirm the card / complete SCA. */
  clientSecret: string;
  status: PaymentIntentStatus;
  amountCents: number;
  currency: string;
}

/** A point-in-time read of an intent (reconciler backstop for a dropped webhook). */
export interface PaymentIntentSnapshot {
  paymentIntentId: string;
  status: PaymentIntentStatus;
  amountCents: number;
  currency: string;
  /** The metadata we attached at creation (carries `operator_transaction_id`). */
  metadata: Record<string, string>;
}

/** A normalized, signature-verified PSP webhook event (async settlement path). */
export interface PspWebhookEvent {
  id: string;
  /** Provider-native type, e.g. "payment_intent.succeeded" / "payment_intent.payment_failed". */
  type: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  status: PaymentIntentStatus;
  /** The metadata we attached at creation (carries `operator_transaction_id`). */
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
  /**
   * Open a PaymentIntent (idempotent on `idempotencyKey`) and return its `client_secret`.
   * Captures NOTHING — settlement is driven later by the verified webhook.
   */
  createPaymentIntent(req: CreateIntentRequest): Promise<PaymentIntentResult>;
  /**
   * Read the current state of an intent directly from the PSP. Used by the reconciler as a
   * backstop when a `succeeded` webhook is lost. Returns `null` if the intent is unknown.
   */
  retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentSnapshot | null>;
  /**
   * Verify a PSP webhook's signature over the RAW body and parse it into a normalized event.
   * Throws {@link PspWebhookSignatureError} on a bad/absent signature.
   */
  parseWebhook(rawBody: string, signatureHeader: string): PspWebhookEvent;
}
