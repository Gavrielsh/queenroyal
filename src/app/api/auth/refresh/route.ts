import type { NextRequest } from "next/server";

import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie, traceId } from "@/lib/auth-http";
import { ok, fail } from "@/lib/http";
import { childLogger } from "@/lib/logger";
import { AuthError, loadClaims, mintAccessToken } from "@/services/auth.service";
import { rotateRefreshToken, SessionStoreUnavailableError } from "@/services/session.service";

export const runtime = "nodejs";

/**
 * Exchange a valid refresh-token cookie for a new short-lived access token, ROTATING the
 * refresh token (single-use). Claims are reloaded from the DB so the new access token
 * reflects the latest KYC/VIP state.
 */
export async function POST(req: NextRequest) {
  const trace_id = traceId(req);
  const reqLog = childLogger({ trace_id, route: "auth/refresh" });

  const token = req.cookies.get(REFRESH_COOKIE)?.value;
  if (!token) {
    return fail({ code: "NO_REFRESH_TOKEN", message: "Missing refresh token", status: 401 });
  }

  try {
    const rotated = await rotateRefreshToken(token);
    if (!rotated) {
      const res = fail({ code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid or expired", status: 401 });
      clearRefreshCookie(res);
      return res;
    }
    const claims = await loadClaims(rotated.userId);
    const accessToken = mintAccessToken(claims);
    const res = ok({ accessToken }, 200);
    setRefreshCookie(res, rotated.refreshToken);
    reqLog.info({ user_id: rotated.userId }, "access token refreshed");
    return res;
  } catch (err) {
    if (err instanceof AuthError) {
      const res = fail({ code: err.code, message: err.message, status: err.status });
      clearRefreshCookie(res);
      return res;
    }
    if (err instanceof SessionStoreUnavailableError) {
      reqLog.error({ err }, "session store unavailable during refresh");
      return fail({ code: "SESSION_STORE_UNAVAILABLE", message: "Service temporarily unavailable", status: 503 });
    }
    reqLog.error({ err }, "unexpected error during refresh");
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }
}
