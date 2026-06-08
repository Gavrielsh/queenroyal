import { mockStripeCharge } from "@/lib/mock-stripe";
import { trueEngine } from "@/lib/true-engine";
import type { EngineTxResult, PurchasePayload, TrueEngineResult } from "@/types/true-engine";

/**
 * A self-contained, fully-idempotent description of a fiat purchase. It is journaled to
 * the EngineRequestLog outbox BEFORE the PSP is charged, so a crash at ANY point — even
 * immediately after capture — leaves a durable record the reconciler can settle. It
 * carries everything needed to (re)settle with no external context:
 *   - `charge`: the PSP charge params, including the stable `idempotencyKey` so re-running
 *     it never double-charges (Stripe returns the existing PaymentIntent).
 *   - `purchase`: the ledger body, keyed by a stable `operator_transaction_id` so the
 *     engine de-duplicates the credit.
 */
export interface DepositInstruction {
  charge: {
    amountCents: number;
    token: string;
    userId: string;
    idempotencyKey: string;
  };
  purchase: PurchasePayload;
}

export type DepositSettlement =
  | { kind: "declined"; reason?: string }
  | { kind: "settled"; paymentIntentId: string; engine: TrueEngineResult<EngineTxResult> };

/**
 * Idempotently capture (or confirm a prior capture of) the PSP charge, then credit the
 * ledger. Safe to call any number of times for the same instruction:
 *   - The PSP charge is idempotent on `charge.idempotencyKey` (no double capture).
 *   - The ledger credit is idempotent on `purchase.operator_transaction_id`.
 *
 * Returns `declined` only when the PSP refuses the card (no funds captured → no coins).
 * Otherwise returns `settled` with the engine result (which may itself be ok or a
 * retryable failure the caller/reconciler will re-drive).
 */
export async function settleDepositIntent(instruction: DepositInstruction): Promise<DepositSettlement> {
  const charge = await mockStripeCharge(instruction.charge);
  if (!charge.ok) {
    return { kind: "declined", reason: charge.declineReason };
  }

  // Stamp the captured payment ref into the ledger metadata for audit/reconciliation.
  const purchase: PurchasePayload = {
    ...instruction.purchase,
    metadata: { ...(instruction.purchase.metadata ?? {}), payment_ref: charge.paymentIntentId },
  };
  const engine = await trueEngine().sendPurchase(purchase);
  return { kind: "settled", paymentIntentId: charge.paymentIntentId, engine };
}
