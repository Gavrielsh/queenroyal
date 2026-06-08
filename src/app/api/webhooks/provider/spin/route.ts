import type { NextRequest } from "next/server";

import { traceId } from "@/lib/auth-http";
import { ok, fail } from "@/lib/http";
import { childLogger } from "@/lib/logger";
import { verifyProviderWebhook, WebhookVerificationError } from "@/lib/webhook-security";
import { providerSpinSchema } from "@/schemas/game.schema";
import { processProviderSpin } from "@/services/game-adapter.service";

export const runtime = "nodejs";

/**
 * B2B webhook receiver for external Game Aggregators (e.g. Pragmatic Play).
 *
 * This is NOT a player endpoint — there is no player JWT. The provider is authenticated
 * by inbound HMAC + timestamp + nonce BEFORE any ledger interaction. Players can never
 * authorize their own winnings here; the authoritative bet/win amounts come from the
 * signed provider payload.
 */
export async function POST(req: NextRequest) {
  const trace_id = traceId(req);
  const reqLog = childLogger({ trace_id, route: "webhooks/provider/spin" });

  // 1) Verify the provider FIRST. This reads the raw body (used for the HMAC), so we
  //    parse JSON from the returned raw bytes rather than calling req.json() again.
  let verified;
  try {
    verified = await verifyProviderWebhook(req);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      reqLog.warn({ err_code: err.code, status: err.status }, "webhook verification rejected");
      return fail({ code: err.code, message: err.message, status: err.status });
    }
    reqLog.error({ err }, "webhook verification error");
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }

  // 2) Parse the verified raw body.
  let body: unknown;
  try {
    body = JSON.parse(verified.rawBody);
  } catch {
    return fail({ code: "INVALID_JSON", message: "Request body must be valid JSON", status: 400 });
  }

  const parsed = providerSpinSchema.safeParse(body);
  if (!parsed.success) {
    return fail({
      code: "VALIDATION_ERROR",
      message: "Invalid spin webhook payload",
      status: 422,
      details: parsed.error.flatten(),
    });
  }

  // 3) Translate and forward to the ledger.
  try {
    const outcome = await processProviderSpin(verified.providerCode, parsed.data, { traceId: trace_id });
    if (!outcome.ok) {
      return fail({
        code: outcome.error.code,
        message: outcome.error.message,
        status: outcome.status,
        details: outcome.error.details,
      });
    }
    return ok(outcome.data, 200);
  } catch (err) {
    reqLog.error({ err, provider_transaction_id: parsed.data.provider_transaction_id }, "unexpected error processing spin");
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }
}
