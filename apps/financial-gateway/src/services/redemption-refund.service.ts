import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import { trueEngine } from "../lib/true-engine";
import { beginEngineRequest, completeEngineRequest } from "./engine-journal.service";

/**
 * The compensating credit — ONE implementation, called from both places a redemption can die.
 *
 * A redemption debits SC_REDEEMABLE when the player asks. Two things can then refuse the
 * payout: an operator at review, and the payout rail terminally. Before this existed, both
 * left the player debited and unpaid, and the code said so honestly rather than pretending
 * otherwise — which was the right thing to do about a gap and no substitute for closing it.
 *
 * WHY IT LIVES HERE AND NOT IN EITHER CALLER
 * The admin route and the worker have nothing else in common, and the thing they share is the
 * part that must not differ: the anchor derivation. Two call sites deriving their own anchor
 * is two chances to derive it differently, and two different anchors for one redemption is a
 * double credit — the exact defect the anchor exists to prevent.
 *
 * NO ARITHMETIC. The amount is read from the row and forwarded verbatim. It is never summed,
 * compared, reformatted or parsed; the string that was debited is the string that is returned.
 */

/** Statuses from which a refund is meaningful — i.e. the debit happened and no payout did. */
export type RefundOutcome =
  | { ok: true; ledgerTransactionId: string; alreadyRefunded: boolean }
  | { ok: false; retryable: boolean; error: string };

/**
 * The idempotency anchor for a redemption's refund.
 *
 * Deterministic and derived SOLELY from the redemption id, so every caller and every retry
 * produces the identical string. That is what makes the engine's de-duplication effective: a
 * retried admin rejection, a redelivered worker message and a manual replay all collapse onto
 * one credit. Exported so a test can assert the derivation rather than infer it.
 */
export function refundAnchor(redemptionId: string): string {
  return `redeem-refund:${redemptionId}`;
}

/**
 * Credit the player back what their redemption debited.
 *
 * Idempotent end to end: the journal insert is ON CONFLICT DO NOTHING on the anchor, and the
 * engine de-duplicates on the same anchor and returns the ORIGINAL receipt for a replay. The
 * result reports `alreadyRefunded` when the engine recognised the anchor, so a caller can log
 * the difference without having to change its behaviour — because its behaviour should not
 * change.
 */
export async function refundRedemption(
  redemptionId: string,
  reason: string,
): Promise<RefundOutcome> {
  const prisma = getPrisma();
  const row = await prisma.redemptionRequest.findUnique({ where: { id: redemptionId } });
  if (!row) {
    return { ok: false, retryable: false, error: `no redemption_requests row for id=${redemptionId}` };
  }

  const flowLog = childLogger({
    component: "redemption-refund",
    redemption_id: redemptionId,
    player_id: row.playerId,
    reason,
  });

  // A redemption whose debit never committed has nothing to give back. Refunding one would
  // credit SC the player never lost — inventing money in the name of fixing an accounting bug.
  if (!row.ledgerTransactionId) {
    flowLog.info("no ledger debit recorded; nothing to refund");
    return { ok: false, retryable: false, error: "redemption has no committed debit to refund" };
  }

  const operatorTransactionId = refundAnchor(redemptionId);
  const payload = {
    operator_transaction_id: operatorTransactionId,
    player_id: row.playerId,
    // Verbatim. Read from the row, forwarded unchanged.
    amount: row.amount,
    reference_transaction_id: row.ledgerTransactionId,
    metadata: { redemption_id: redemptionId, refund_reason: reason },
  };

  // Journal before the call, as every money path does: a crash mid-flight leaves a durable
  // record the reconciler can act on rather than an unanswered question.
  await beginEngineRequest({
    operatorTransactionId,
    type: "REDEEM",
    playerId: row.playerId,
    providerRef: redemptionId,
    requestPayload: payload,
  });

  const res = await trueEngine().sendRedemptionRefund(payload);
  if (!res.ok) {
    await completeEngineRequest(operatorTransactionId, "FAILED", {
      retryable: res.retryable,
      lastError: `${res.error.code}: ${res.error.message}`,
    });
    flowLog.error(
      { alert: "refund_failed", err_code: res.error.code, retryable: res.retryable },
      "refund failed — the player is still debited",
    );
    return { ok: false, retryable: res.retryable, error: `${res.error.code}: ${res.error.message}` };
  }

  await completeEngineRequest(operatorTransactionId, "SUCCEEDED", {
    ledgerTransactionId: res.data.ledger_transaction_id,
  });

  // The engine reports CACHED or GHOST_RECOVERED when it recognised the anchor — i.e. this
  // refund had already been credited and no second credit was made.
  const alreadyRefunded = res.data.status === "CACHED" || res.data.status === "GHOST_RECOVERED";
  await prisma.redemptionRequest.update({
    where: { id: redemptionId },
    data: { refundLedgerTransactionId: res.data.ledger_transaction_id, refundedAt: new Date() },
  });

  flowLog.info(
    { ledger_transaction_id: res.data.ledger_transaction_id, already_refunded: alreadyRefunded },
    "redemption refunded",
  );
  return { ok: true, ledgerTransactionId: res.data.ledger_transaction_id, alreadyRefunded };
}
