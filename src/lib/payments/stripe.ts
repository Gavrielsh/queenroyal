import {
  type ChargeRequest,
  type ChargeResult,
  type PaymentProvider,
  PaymentProviderNotConfiguredError,
  type PspWebhookEvent,
} from "@/lib/payments/types";

/**
 * Stripe integration SEAM. This is the exact shape a real Stripe implementation plugs
 * into — same `PaymentProvider` contract the cashier already consumes. The `stripe` SDK
 * is intentionally NOT a dependency yet, so the methods fail loudly
 * (PaymentProviderNotConfiguredError) until it is wired. The inline comments are the
 * literal SDK calls to drop in.
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

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    // const stripe = new Stripe(this.config.secretKey);
    // const intent = await stripe.paymentIntents.create(
    //   {
    //     amount: req.amountCents,
    //     currency: req.currency.toLowerCase(),
    //     payment_method: req.paymentMethodToken,
    //     customer: req.customerRef, // or a mapped Stripe customer id
    //     confirm: true,
    //     metadata: req.metadata,    // carries operator_transaction_id for the webhook
    //     automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    //   },
    //   { idempotencyKey: req.idempotencyKey }, // <-- real PSP idempotency key
    // );
    // return mapPaymentIntent(intent); // status "succeeded" | "requires_action" | "failed"
    void req;
    throw new PaymentProviderNotConfiguredError(
      "Stripe provider selected but the SDK is not wired (install `stripe` and implement charge()).",
    );
  }

  parseWebhook(rawBody: string, signatureHeader: string): PspWebhookEvent {
    // const stripe = new Stripe(this.config.secretKey);
    // const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, this.config.webhookSecret);
    // // ^ throws on a bad signature — map to PspWebhookSignatureError
    // const intent = event.data.object as Stripe.PaymentIntent;
    // return {
    //   id: event.id,
    //   type: event.type, // e.g. "payment_intent.succeeded"
    //   paymentIntentId: intent.id,
    //   amountCents: intent.amount,
    //   currency: intent.currency.toUpperCase(),
    //   status: mapIntentStatus(intent.status),
    //   metadata: intent.metadata ?? {},
    // };
    void rawBody;
    void signatureHeader;
    throw new PaymentProviderNotConfiguredError(
      "Stripe provider selected but the SDK is not wired (install `stripe` and implement parseWebhook()).",
    );
  }
}
