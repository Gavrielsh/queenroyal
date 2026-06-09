import {
  type CreateIntentRequest,
  type PaymentIntentResult,
  type PaymentIntentSnapshot,
  type PaymentProvider,
  PaymentProviderNotConfiguredError,
  type PspWebhookEvent,
} from "./types";

/**
 * Stripe integration SEAM. This is the exact shape a real Stripe implementation plugs into —
 * the same async `PaymentProvider` contract the cashier already consumes. The `stripe` SDK is
 * intentionally NOT a dependency yet, so the methods fail loudly
 * (PaymentProviderNotConfiguredError) until it is wired. The inline comments are the literal
 * SDK calls to drop in.
 *
 * To activate:
 *   1. `npm install stripe`
 *   2. set PAYMENT_PROVIDER=stripe, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   3. replace the throws below with the commented SDK calls.
 */
export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";

  constructor(private readonly config: StripeConfig) {}

  async createPaymentIntent(req: CreateIntentRequest): Promise<PaymentIntentResult> {
    // const stripe = new Stripe(this.config.secretKey);
    // const intent = await stripe.paymentIntents.create(
    //   {
    //     amount: req.amountCents,
    //     currency: req.currency.toLowerCase(),
    //     customer: req.customerRef, // or a mapped Stripe customer id
    //     // No `confirm: true`: the frontend confirms with the client_secret (handles 3DS).
    //     metadata: req.metadata, // carries operator_transaction_id for the webhook
    //     automatic_payment_methods: { enabled: true },
    //   },
    //   { idempotencyKey: req.idempotencyKey }, // <-- real PSP idempotency key
    // );
    // return { paymentIntentId: intent.id, clientSecret: intent.client_secret ?? "", ... };
    void req;
    throw new PaymentProviderNotConfiguredError(
      "Stripe provider selected but the SDK is not wired (install `stripe` and implement createPaymentIntent()).",
    );
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentSnapshot | null> {
    // const stripe = new Stripe(this.config.secretKey);
    // const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    // ... map intent → PaymentIntentSnapshot ...
    void paymentIntentId;
    throw new PaymentProviderNotConfiguredError(
      "Stripe provider selected but the SDK is not wired (install `stripe` and implement retrievePaymentIntent()).",
    );
  }

  parseWebhook(rawBody: string, signatureHeader: string): PspWebhookEvent {
    // const stripe = new Stripe(this.config.secretKey);
    // const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, this.config.webhookSecret);
    // // ^ throws on a bad signature — map to PspWebhookSignatureError
    // ... map event.data.object (PaymentIntent) → PspWebhookEvent ...
    void rawBody;
    void signatureHeader;
    throw new PaymentProviderNotConfiguredError(
      "Stripe provider selected but the SDK is not wired (install `stripe` and implement parseWebhook()).",
    );
  }
}
