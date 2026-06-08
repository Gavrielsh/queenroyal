import type { NextRequest } from "next/server";

import { enforceAuthRateLimit, setRefreshCookie, traceId } from "@/lib/auth-http";
import { ok, fail } from "@/lib/http";
import { childLogger } from "@/lib/logger";
import { loginSchema } from "@/schemas/auth.schema";
import { AuthError, login } from "@/services/auth.service";
import { SessionStoreUnavailableError } from "@/services/session.service";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const trace_id = traceId(req);
  const reqLog = childLogger({ trace_id, route: "auth/login" });

  const limited = await enforceAuthRateLimit(req, "login");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail({ code: "INVALID_JSON", message: "Request body must be valid JSON", status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return fail({ code: "VALIDATION_ERROR", message: "Invalid login payload", status: 422, details: parsed.error.flatten() });
  }

  try {
    const result = await login(parsed.data);
    const res = ok({ user: result.user, accessToken: result.accessToken }, 200);
    setRefreshCookie(res, result.refreshToken);
    reqLog.info({ user_id: result.user.id }, "login succeeded");
    return res;
  } catch (err) {
    if (err instanceof AuthError) {
      return fail({ code: err.code, message: err.message, status: err.status });
    }
    if (err instanceof SessionStoreUnavailableError) {
      reqLog.error({ err }, "session store unavailable during login");
      return fail({ code: "SESSION_STORE_UNAVAILABLE", message: "Service temporarily unavailable", status: 503 });
    }
    reqLog.error({ err }, "unexpected error during login");
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }
}
