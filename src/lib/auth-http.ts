import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { getEnv } from "@/lib/env";
import { fail } from "@/lib/http";
import { log } from "@/lib/logger";
import { rateLimit, RateLimiterUnavailableError } from "@/lib/rate-limit";

/** Name of the HttpOnly refresh-token cookie. Scoped to the auth routes only. */
export const REFRESH_COOKIE = "qr_refresh_token";

/** Best-effort client IP for rate-limit bucketing (first XFF hop, then X-Real-IP). */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** A stable trace id for the request: an inbound id if present, else a fresh UUID. */
export function traceId(req: NextRequest): string {
  return req.headers.get("x-request-id") ?? req.headers.get("x-trace-id") ?? randomUUID();
}

function refreshCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/api/auth",
    maxAge,
  };
}

export function setRefreshCookie(res: NextResponse, token: string): void {
  res.cookies.set(REFRESH_COOKIE, token, refreshCookieOptions(getEnv().JWT_REFRESH_TTL_SECONDS));
}

export function clearRefreshCookie(res: NextResponse): void {
  res.cookies.set(REFRESH_COOKIE, "", refreshCookieOptions(0));
}

/**
 * Enforce the auth rate limit for `bucket` (e.g. "login") keyed by client IP.
 *
 * STRICT / FAIL CLOSED (Phase 4): the auth surface is brute-force-sensitive, so it relies
 * EXCLUSIVELY on the distributed Redis limiter. There is no process-local fallback. If Redis
 * is unreachable (or the shared breaker is open) the limiter cannot vouch for the request, so
 * we refuse to admit it against untracked state and return `503 Service Unavailable` rather
 * than silently weakening brute-force protection.
 *
 * Returns a 429 response when the limit is exceeded, a 503 response when the limiter is
 * unavailable, or null to proceed.
 */
export async function enforceAuthRateLimit(req: NextRequest, bucket: string): Promise<NextResponse | null> {
  const env = getEnv();
  const ip = clientIp(req);

  let result;
  try {
    result = await rateLimit(`auth:${bucket}:${ip}`, env.AUTH_RATE_LIMIT_MAX, env.AUTH_RATE_LIMIT_WINDOW_SECONDS);
  } catch (err) {
    if (err instanceof RateLimiterUnavailableError) {
      log().error({ bucket, ip }, "auth rate limiter unavailable (Redis down) — failing closed with 503");
      return fail({ code: "RATE_LIMITER_UNAVAILABLE", message: "Service temporarily unavailable", status: 503 });
    }
    throw err;
  }

  if (!result.allowed) {
    const res = fail({ code: "RATE_LIMITED", message: "Too many requests; please slow down", status: 429 });
    res.headers.set("Retry-After", String(result.retryAfterSeconds));
    return res;
  }
  return null;
}
