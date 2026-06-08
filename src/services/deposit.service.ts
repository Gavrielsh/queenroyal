import { getPaymentProvider } from "@/lib/payments";
import type { ChargeRequest } from "@/lib/payments/types";
import { trueEngine } from "@/lib/true-engine";
import type { EngineTxResult, PurchasePayload, TrueEngineResult } from "@/types/true-engine";

/**
 * A self-contained, fully-idempotent description of a fiat purchase. It is journaled to
 * the EngineRequestLog outbox BEFORE the PSP is charged, so a crash at ANY point — even
 * immediately after capture — leaves a durable record the reconciler can settle. It
 * carries everything needed to (re)settle with no external context:
 *   - `charge`: the PSP charge request, including the stable `idempotencyKey` so
 *     re-running it never double-charges, and metadata carrying `operator_transaction_id`
 *     for async webhook correlation.
 *   - `purchase`: the ledger body, keyed by a stable `operator_transaction_id` so the
 *     engine de-duplicates the credit.
 */
export interface DepositInstruction {
  charge: ChargeRequest;
  purchase: PurchasePayload;
}

export type DepositSettlement =
  | { kind: "declined"; reason?: string }
  | { kind: "pending_action"; paymentIntentId: string; clientSecret?: string }
  | { kind: "settled"; paymentIntentId: string; engine: TrueEngineResult<EngineTxResult> };

/**
 * Idempotently capture (or confirm a prior capture of) the PSP charge, then credit the
 * ledger. Safe to call any number of times for the same instruction:
 *   - The PSP charge is idempotent on `charge.idempotencyKey` (no double capture).
 *   - The ledger credit is idempotent on `purchase.operator_transaction_id`.
 *
 * Returns:
 *   - `declined`        — the PSP refused the card (no funds captured → no coins).
 *   - `pending_action`  — the charge needs customer SCA/3DS; the deposit stays PENDING and
 *                         is settled later by the PSP webhook (or a subsequent reconcile).
 *   - `settled`         — captured; carries the engine result (ok or a retryable failure
 *                         the caller/reconciler will re-drive).
 */
export async function settleDepositIntent(instruction: DepositInstruction): Promise<DepositSettlement> {
  const charge = await getPaymentProvider().charge(instruction.charge);

  if (charge.status === "failed") {
    return { kind: "declined", reason: charge.declineReason };
  }
  if (charge.status === "requires_action") {
    return { kind: "pending_action", paymentIntentId: charge.paymentIntentId, clientSecret: charge.clientSecret };
  }

  // succeeded → stamp the captured payment ref into the ledger metadata for audit.
  const purchase: PurchasePayload = {
    ...instruction.purchase,
    metadata: { ...(instruction.purchase.metadata ?? {}), payment_ref: charge.paymentIntentId },
  };
  const engine = await trueEngine().sendPurchase(purchase);
  return { kind: "settled", paymentIntentId: charge.paymentIntentId, engine };
}
