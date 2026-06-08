import type { NextRequest } from "next/server";

import { clearRefreshCookie, REFRESH_COOKIE, traceId } from "@/lib/auth-http";
import { ok } from "@/lib/http";
import { childLogger } from "@/lib/logger";
import { revokeRefreshToken } from "@/services/session.service";

export const runtime = "nodejs";

/** Revoke the refresh session and clear the cookie. Idempotent. */
export async function POST(req: NextRequest) {
  const trace_id = traceId(req);
  const reqLog = childLogger({ trace_id, route: "auth/logout" });

  const token = req.cookies.get(REFRESH_COOKIE)?.value;
  const res = ok({ loggedOut: true }, 200);
  clearRefreshCookie(res);

  if (token) {
    try {
      await revokeRefreshToken(token);
    } catch (err) {
      // The cookie is cleared regardless; a failed revoke (e.g. Redis blip) is logged but
      // does not block the client from logging out.
      reqLog.warn({ err }, "refresh token revoke failed on logout");
    }
  }
  return res;
}
