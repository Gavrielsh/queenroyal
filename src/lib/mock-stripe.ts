import { randomUUID } from "node:crypto";

/**
 * Mock Payment Service Provider (stands in for Stripe).
 *
 * Deterministic for testing: a token beginning with "tok_decline" fails the charge;
 * anything else succeeds. Returns a PaymentIntent-style reference used downstream as
 * the ledger deposit's `payment_ref`.
 */

export interface MockChargeParams {
  amountCents: number;
  token: string;
  userId: string;
}

export interface MockChargeResult {
  ok: boolean;
  paymentIntentId: string;
  amountCents: number;
  declineReason?: string;
}

export async function mockStripeCharge(params: MockChargeParams): Promise<MockChargeResult> {
  const { amountCents, token } = params;
  const paymentIntentId = `pi_${randomUUID()}`;

  if (token.startsWith("tok_decline")) {
    return { ok: false, paymentIntentId, amountCents, declineReason: "card_declined" };
  }

  return { ok: true, paymentIntentId, amountCents };
}
