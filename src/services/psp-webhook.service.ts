import { childLogger } from "@/lib/logger";
import type { PspWebhookEvent } from "@/lib/payments/types";
import { prisma } from "@/lib/prisma";
import { depositInstructionSchema } from "@/schemas/engine-payloads.schema";
import { creditConfirmedDeposit } from "@/services/deposit.service";
import { completeEngineRequest } from "@/services/engine-journal.service";

export interface PspWebhookOutcome {
  handled: boolean;
  note: string;
}

const SUCCEEDED_TYPE = "payment_intent.succeeded";
const FAILED_TYPE = "payment_intent.payment_failed";

/**
 * Async settlement entry point. A verified PSP webhook is dispatched here:
 *
 *   - `payment_intent.succeeded` → idempotently credit the ledger (exactly once). The
 *     deposit's `operator_transaction_id` is carried in the event metadata; we look up the
 *     durably-journaled instruction and run the same idempotent credit the reconciler uses.
 *   - `payment_intent.payment_failed` → mark the PENDING deposit terminal. No funds were
 *     captured, so nothing is owed.
 *
 * Idempotency is anchored in Postgres: a row already `SUCCEEDED` is a no-op, and the engine
 * itself de-duplicates on `operator_transaction_id`. A re-delivered `succeeded` event
 * therefore never double-credits.
 */
export async function handlePspWebhookEvent(event: PspWebhookEvent, traceId?: string): Promise<PspWebhookOutcome> {
  const opTxId = event.metadata.operator_transaction_id;
  const log = childLogger({
    trace_id: traceId,
    component: "psp-webhook",
    psp_event_type: event.type,
    payment_intent_id: event.paymentIntentId, // the payment_ref
    operator_transaction_id: opTxId,
  });

  if (!opTxId) {
    log.warn("psp event without operator_transaction_id metadata; ignored");
    return { handled: false, note: "missing operator_transaction_id" };
  }

  const isSuccess = event.type === SUCCEEDED_TYPE || event.status === "succeeded";
  const isFailure = event.type === FAILED_TYPE || event.status === "failed" || event.status === "canceled";
  if (!isSuccess && !isFailure) {
    log.info({ status: event.status }, "psp event ignored (non-terminal)");
    return { handled: false, note: "non-terminal event" };
  }

  const row = await prisma.engineRequestLog.findUnique({ where: { operatorTransactionId: opTxId } });
  if (!row || row.type !== "DEPOSIT") {
    log.warn("no matching deposit intent for psp event");
    return { handled: false, note: "no matching deposit intent" };
  }

  // ── Failure: terminal, nothing captured. Only act while still PENDING. ──
  if (isFailure) {
    if (row.status === "PENDING") {
      await prisma.engineRequestLog.update({
        where: { id: row.id },
        data: { status: "ABANDONED", retryable: false, lastError: `psp ${event.type}` },
      });
      log.info("deposit intent failed at PSP (no capture) — marked terminal");
      return { handled: true, note: "psp failure recorded" };
    }
    log.info({ status: row.status }, "psp failure for non-pending deposit; ignored");
    return { handled: false, note: "deposit not pending" };
  }

  // ── Success: drive the idempotent ledger credit. ──
  if (row.status === "SUCCEEDED") {
    return { handled: true, note: "already settled" };
  }

  // Phase 3: STRICT-validate the journaled instruction before replaying it. A corrupted
  // JSONB blob must never reach the ledger.
  const parsed = depositInstructionSchema.safeParse(row.requestPayload);
  if (!parsed.success) {
    log.fatal({ alert: "corrupt_deposit_payload" }, "CRITICAL: deposit payload failed schema validation; refusing to credit");
    return { handled: false, note: "corrupt deposit payload" };
  }
  const instruction = parsed.data;

  // Defense-in-depth: the captured amount must match what we journaled. The ledger credit
  // uses OUR stored coin amounts (not the event's), but a mismatch signals tampering or a
  // wrong correlation, so we refuse rather than credit.
  if (event.amountCents !== instruction.expectedAmountCents || event.currency !== instruction.currency) {
    log.fatal(
      { alert: "psp_amount_mismatch", event_amount_cents: event.amountCents, expected_cents: instruction.expectedAmountCents },
      "CRITICAL: PSP webhook amount/currency mismatch; refusing to credit",
    );
    return { handled: false, note: "amount/currency mismatch" };
  }

  const credit = await creditConfirmedDeposit(instruction);
  if (!credit.ok) {
    // Capture is confirmed but the ledger credit failed → leave a retryable FAILED intent.
    // The reconciler re-drives the credit only (never a re-charge); idempotent at the engine.
    await completeEngineRequest(opTxId, "FAILED", {
      retryable: credit.retryable,
      lastError: `${credit.error.code}: ${credit.error.message}`,
    });
    log.error({ err_code: credit.error.code, retryable: credit.retryable }, "ledger credit failed during psp webhook settle — handed to reconciler");
    return { handled: false, note: "ledger credit failed" };
  }

  await completeEngineRequest(opTxId, "SUCCEEDED", {
    ledgerTransactionId: credit.data.ledger_transaction_id,
  });
  log.info({ ledger_transaction_id: credit.data.ledger_transaction_id }, "deposit settled via psp webhook");
  return { handled: true, note: "settled" };
}
