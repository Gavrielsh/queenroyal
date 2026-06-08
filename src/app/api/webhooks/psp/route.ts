import type { NextRequest } from "next/server";

import { traceId } from "@/lib/auth-http";
import { ok, fail } from "@/lib/http";
import { childLogger } from "@/lib/logger";
import { getPaymentProvider } from "@/lib/payments";
import { PaymentProviderNotConfiguredError, PspWebhookSignatureError } from "@/lib/payments/types";
import { handlePspWebhookEvent } from "@/services/psp-webhook.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stripe sends `Stripe-Signature`; accept a generic `X-PSP-Signature` too.
const SIGNATURE_HEADERS = ["stripe-signature", "x-psp-signature"];

/**
 * PSP webhook receiver for ASYNC settlement (e.g. `payment_intent.succeeded` after SCA).
 * The raw body is signature-verified by the configured provider before any action, then
 * the referenced deposit intent is settled idempotently.
 */
export async function POST(req: NextRequest) {
  const trace_id = traceId(req);
  const reqLog = childLogger({ trace_id, route: "webhooks/psp" });

  const signature = SIGNATURE_HEADERS.map((h) => req.headers.get(h)).find((v): v is string => Boolean(v)) ?? "";
  const rawBody = await req.text();

  let event;
  try {
    event = getPaymentProvider().parseWebhook(rawBody, signature);
  } catch (err) {
    if (err instanceof PspWebhookSignatureError) {
      reqLog.warn("psp webhook signature rejected");
      return fail({ code: err.code, message: "invalid signature", status: 401 });
    }
    if (err instanceof PaymentProviderNotConfiguredError) {
      reqLog.error({ err }, "psp provider not configured");
      return fail({ code: err.code, message: "PSP not configured", status: 503 });
    }
    reqLog.error({ err }, "psp webhook parse error");
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }

  try {
    const result = await handlePspWebhookEvent(event, trace_id);
    // Always 200 once verified+received so the PSP stops retrying; the body reports action.
    return ok({ received: true, ...result }, 200);
  } catch (err) {
    reqLog.error({ err, payment_intent_id: event.paymentIntentId }, "psp webhook handling failed");
    return fail({ code: "INTERNAL_ERROR", message: "Webhook handling failed", status: 500 });
  }
}
