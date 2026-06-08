import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  type CreateIntentRequest,
  type PaymentIntentResult,
  type PaymentIntentSnapshot,
  type PaymentIntentStatus,
  type PaymentProvider,
  type PspWebhookEvent,
  PspWebhookSignatureError,
} from "@/lib/payments/types";

/**
 * Mock PSP (stands in for Stripe in dev/test). It models the ASYNC lifecycle: opening an
 * intent captures nothing and returns a `client_secret`; settlement arrives later as a
 * signed webhook (or is observed by polling `retrievePaymentIntent`).
 *
 * `createPaymentIntent` is idempotent on `idempotencyKey` (a real Stripe Idempotency-Key
 * returns the same PaymentIntent), and `parseWebhook` verifies an HMAC-SHA256 signature
 * over the raw body exactly as a real PSP webhook would, so the integration seam is
 * realistic. Tests advance the lifecycle deterministically via
 * {@link MockPaymentProvider.markIntentSucceeded} / {@link MockPaymentProvider.markIntentFailed}.
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

interface StoredIntent {
  paymentIntentId: string;
  clientSecret: string;
  status: PaymentIntentStatus;
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
}

function isPaymentIntentStatus(v: unknown): v is PaymentIntentStatus {
  return (
    v === "requires_payment_method" ||
    v === "requires_confirmation" ||
    v === "requires_action" ||
    v === "processing" ||
    v === "succeeded" ||
    v === "canceled" ||
    v === "failed"
  );
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  private readonly intents = new Map<string, StoredIntent>(); // paymentIntentId → intent
  private readonly byIdempotencyKey = new Map<string, string>(); // idempotencyKey → paymentIntentId

  constructor(private readonly webhookSecret: string) {}

  async createPaymentIntent(req: CreateIntentRequest): Promise<PaymentIntentResult> {
    const existingId = this.byIdempotencyKey.get(req.idempotencyKey);
    if (existingId) {
      const existing = this.intents.get(existingId);
      if (existing) return toResult(existing);
    }

    const intent: StoredIntent = {
      paymentIntentId: `pi_${randomUUID()}`,
      clientSecret: `pi_${randomUUID()}_secret_${randomUUID()}`,
      // Opened but not yet confirmed: the frontend must confirm the card next.
      status: "requires_confirmation",
      amountCents: req.amountCents,
      currency: req.currency,
      metadata: { ...(req.metadata ?? {}) },
    };
    this.intents.set(intent.paymentIntentId, intent);
    this.byIdempotencyKey.set(req.idempotencyKey, intent.paymentIntentId);
    return toResult(intent);
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentSnapshot | null> {
    const intent = this.intents.get(paymentIntentId);
    if (!intent) return null;
    return {
      paymentIntentId: intent.paymentIntentId,
      status: intent.status,
      amountCents: intent.amountCents,
      currency: intent.currency,
      metadata: { ...intent.metadata },
    };
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

    const status: PaymentIntentStatus = isPaymentIntentStatus(body.status) ? body.status : "failed";

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

  // ── Test seams: advance an intent's lifecycle deterministically ──────────────

  /** Mark a previously-opened intent as captured (`succeeded`). */
  markIntentSucceeded(paymentIntentId: string): void {
    this.transition(paymentIntentId, "succeeded");
  }

  /** Mark a previously-opened intent as failed (declined / SCA abandoned). */
  markIntentFailed(paymentIntentId: string): void {
    this.transition(paymentIntentId, "failed");
  }

  /**
   * Build the signed webhook envelope a real PSP would POST, for the given intent. The
   * returned `signature` is HMAC-SHA256(rawBody, webhookSecret) — exactly what
   * {@link parseWebhook} verifies.
   */
  buildSignedWebhook(paymentIntentId: string, type: string): { rawBody: string; signature: string } {
    const intent = this.intents.get(paymentIntentId);
    if (!intent) throw new Error(`mock intent ${paymentIntentId} not found`);
    const body: MockWebhookBody = {
      id: `evt_${randomUUID()}`,
      type,
      payment_intent_id: intent.paymentIntentId,
      amount_cents: intent.amountCents,
      currency: intent.currency,
      status: type === "payment_intent.succeeded" ? "succeeded" : "failed",
      metadata: intent.metadata,
    };
    const rawBody = JSON.stringify(body);
    const signature = createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest("hex");
    return { rawBody, signature };
  }

  private transition(paymentIntentId: string, status: PaymentIntentStatus): void {
    const intent = this.intents.get(paymentIntentId);
    if (!intent) throw new Error(`mock intent ${paymentIntentId} not found`);
    intent.status = status;
  }
}

function toResult(intent: StoredIntent): PaymentIntentResult {
  return {
    paymentIntentId: intent.paymentIntentId,
    clientSecret: intent.clientSecret,
    status: intent.status,
    amountCents: intent.amountCents,
    currency: intent.currency,
  };
}
