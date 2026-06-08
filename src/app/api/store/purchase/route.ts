import type { NextRequest } from "next/server";

import { traceId } from "@/lib/auth-http";
import { requireAuth, UnauthorizedError } from "@/lib/auth-guard";
import { ok, fail } from "@/lib/http";
import { childLogger } from "@/lib/logger";
import { purchaseSchema } from "@/schemas/store.schema";
import { purchasePackage } from "@/services/store.service";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const trace_id = traceId(req);
  const reqLog = childLogger({ trace_id, route: "store/purchase" });

  let user;
  try {
    user = requireAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return fail({ code: "UNAUTHORIZED", message: err.message, status: 401 });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail({ code: "INVALID_JSON", message: "Request body must be valid JSON", status: 400 });
  }

  const parsed = purchaseSchema.safeParse(body);
  if (!parsed.success) {
    return fail({
      code: "VALIDATION_ERROR",
      message: "Invalid purchase payload",
      status: 422,
      details: parsed.error.flatten(),
    });
  }

  try {
    const outcome = await purchasePackage(user, parsed.data, { traceId: trace_id });
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
    reqLog.error({ err, user_id: user.sub }, "unexpected error processing purchase");
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }
}
