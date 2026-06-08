import { childLogger } from "@/lib/logger";
import type { PspWebhookEvent } from "@/lib/payments/types";
import { prisma } from "@/lib/prisma";
import { type DepositInstruction, settleDepositIntent } from "@/services/deposit.service";
import { completeEngineRequest } from "@/services/engine-journal.service";

export interface PspWebhookOutcome {
  handled: boolean;
  note: string;
}

/**
 * Async settlement: a verified PSP webhook (e.g. `payment_intent.succeeded`) settles the
 * deposit intent it references. The intent's `operator_transaction_id` is carried in the
 * charge metadata, so we look up the (durably journaled) DepositInstruction and run the
 * same idempotent settle the synchronous flow and the reconciler use.
 */
export async function handlePspWebhookEvent(event: PspWebhookEvent, traceId?: string): Promise<PspWebhookOutcome> {
  const opTxId = event.metadata.operator_transaction_id;
  const log = childLogger({
    trace_id: traceId,
    component: "psp-webhook",
    psp_event_type: event.type,
    payment_intent_id: event.paymentIntentId,
    operator_transaction_id: opTxId,
  });

  if (!opTxId) {
    log.warn("psp event without operator_transaction_id metadata; ignored");
    return { handled: false, note: "missing operator_transaction_id" };
  }

  // Only success drives a credit. Non-success events are left to the reconciler.
  if (event.type !== "payment_intent.succeeded" && event.status !== "succeeded") {
    log.info({ status: event.status }, "psp event ignored (non-success)");
    return { handled: false, note: "non-success event" };
  }

  const row = await prisma.engineRequestLog.findUnique({ where: { operatorTransactionId: opTxId } });
  if (!row || row.type !== "DEPOSIT" || row.requestPayload == null) {
    log.warn("no matching deposit intent for psp event");
    return { handled: false, note: "no matching deposit intent" };
  }
  if (row.status === "SUCCEEDED") {
    return { handled: true, note: "already settled" };
  }

  const settlement = await settleDepositIntent(row.requestPayload as unknown as DepositInstruction);
  if (settlement.kind !== "settled") {
    log.warn({ kind: settlement.kind }, "psp webhook settle did not capture+credit");
    return { handled: false, note: `settlement ${settlement.kind}` };
  }
  if (!settlement.engine.ok) {
    await completeEngineRequest(opTxId, "FAILED", {
      retryable: settlement.engine.retryable,
      lastError: `${settlement.engine.error.code}: ${settlement.engine.error.message}`,
    });
    log.error({ err_code: settlement.engine.error.code }, "ledger credit failed during psp webhook settle — handed to reconciler");
    return { handled: false, note: "ledger credit failed" };
  }

  await completeEngineRequest(opTxId, "SUCCEEDED", {
    ledgerTransactionId: settlement.engine.data.ledger_transaction_id,
  });
  log.info("deposit settled via psp webhook");
  return { handled: true, note: "settled" };
}
