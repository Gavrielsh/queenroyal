import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  type ChargeRequest,
  type ChargeResult,
  type PaymentProvider,
  type PspWebhookEvent,
  PspWebhookSignatureError,
} from "@/lib/payments/types";

/**
 * Mock PSP (stands in for Stripe in dev/test). Deterministic test tokens:
 *   - "tok_decline*" → failed charge
 *   - "tok_action*"  → requires_action (exercises the async/SCA settlement path)
 *   - anything else  → succeeded
 *
 * The charge is idempotent on `idempotencyKey` (a real Stripe Idempotency-Key returns the
 * same PaymentIntent), and `parseWebhook` verifies an HMAC-SHA256 signature over the raw
 * body exactly as a real PSP webhook would, so the integration seam is realistic.
 */
const HEX_RE = /^[0-9a-fA-F]+$/;

interface MockWebhookBody {
  id?: string;
  type?: string;
  payment_intent_id?: string;
  amount_cents?: number;
  currency?: string;
  status?: string;
  metadata?: Record<string, string>;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  private readonly charges = new Map<string, ChargeResult>(); // idempotencyKey → result

  constructor(private readonly webhookSecret: string) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const existing = this.charges.get(req.idempotencyKey);
    if (existing) return existing;

    let result: ChargeResult;
    if (req.paymentMethodToken.startsWith("tok_decline")) {
      result = {
        status: "failed",
        paymentIntentId: `pi_${randomUUID()}`,
        amountCents: req.amountCents,
        currency: req.currency,
        declineReason: "card_declined",
      };
    } else if (req.paymentMethodToken.startsWith("tok_action")) {
      result = {
        status: "requires_action",
        paymentIntentId: `pi_${randomUUID()}`,
        amountCents: req.amountCents,
        currency: req.currency,
        clientSecret: `seti_${randomUUID()}_secret`,
      };
    } else {
      result = {
        status: "succeeded",
        paymentIntentId: `pi_${randomUUID()}`,
        amountCents: req.amountCents,
        currency: req.currency,
      };
    }

    this.charges.set(req.idempotencyKey, result);
    return result;
  }

  parseWebhook(rawBody: string, signatureHeader: string): PspWebhookEvent {
    if (!signatureHeader || !HEX_RE.test(signatureHeader) || signatureHeader.length % 2 !== 0) {
      throw new PspWebhookSignatureError();
    }
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest();
    const provided = Buffer.from(signatureHeader, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new PspWebhookSignatureError();
    }

    let body: MockWebhookBody;
    try {
      body = JSON.parse(rawBody) as MockWebhookBody;
    } catch {
      throw new PspWebhookSignatureError("webhook body is not valid JSON");
    }

    const status: ChargeResult["status"] =
      body.status === "succeeded" || body.status === "failed" || body.status === "requires_action"
        ? body.status
        : "failed";

    return {
      id: body.id ?? randomUUID(),
      type: body.type ?? "payment_intent.unknown",
      paymentIntentId: body.payment_intent_id ?? "",
      amountCents: body.amount_cents ?? 0,
      currency: body.currency ?? "USD",
      status,
      metadata: body.metadata ?? {},
    };
  }
}
