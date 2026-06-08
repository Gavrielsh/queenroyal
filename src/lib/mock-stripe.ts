import { randomUUID } from "node:crypto";

/**
 * Mock Payment Service Provider (stands in for Stripe).
 *
 * Deterministic for testing: a token beginning with "tok_decline" fails the charge;
 * anything else succeeds. Returns a PaymentIntent-style reference used downstream as
 * the ledger purchase's `payment_ref`.
 *
 * NOTE: USD amounts ARE integer cents here — that is correct for the PSP boundary (and
 * only the PSP). Coin amounts sent to the ledger are decimal strings (see @/lib/money).
 */

export interface MockChargeParams {
  amountCents: number;
  token: string;
  userId: string;
  /** When provided, the same key returns the same PaymentIntent (charge-once on retry). */
  idempotencyKey?: string;
}

export interface MockChargeResult {
  ok: boolean;
  paymentIntentId: string;
  amountCents: number;
  declineReason?: string;
}

// Process-local idempotency cache for the mock. Production Stripe enforces this
// server-side via the Idempotency-Key header.
const chargesByKey = new Map<string, string>(); // idempotencyKey → paymentIntentId

export async function mockStripeCharge(params: MockChargeParams): Promise<MockChargeResult> {
  const { amountCents, token, idempotencyKey } = params;

  if (token.startsWith("tok_decline")) {
    return { ok: false, paymentIntentId: `pi_${randomUUID()}`, amountCents, declineReason: "card_declined" };
  }

  if (idempotencyKey) {
    const existing = chargesByKey.get(idempotencyKey);
    if (existing) return { ok: true, paymentIntentId: existing, amountCents };
    const paymentIntentId = `pi_${randomUUID()}`;
    chargesByKey.set(idempotencyKey, paymentIntentId);
    return { ok: true, paymentIntentId, amountCents };
  }

  return { ok: true, paymentIntentId: `pi_${randomUUID()}`, amountCents };
}
