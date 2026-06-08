import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { getEnv } from "@/lib/env";
import { fail } from "@/lib/http";
import { log } from "@/lib/logger";
import { rateLimitDegraded } from "@/lib/rate-limit";

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
 * Auth is a NON-financial path, so it GRACEFULLY DEGRADES (Phase 2): the distributed Redis
 * limiter is preferred, but if Redis is down the request is throttled by a strict
 * process-local leaky bucket instead of 503-ing — a dead Redis must not take the login
 * route (and the gateway) offline. The fallback is intentionally tight, so brute-force
 * protection is reduced but never removed.
 *
 * Returns a 429 response when the (Redis or fallback) limit is exceeded, or null to proceed.
 */
export async function enforceAuthRateLimit(req: NextRequest, bucket: string): Promise<NextResponse | null> {
  const env = getEnv();
  const ip = clientIp(req);
  const result = await rateLimitDegraded(
    `auth:${bucket}:${ip}`,
    env.AUTH_RATE_LIMIT_MAX,
    env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    env.AUTH_DEGRADED_RATE_LIMIT_MAX,
  );

  if (result.degraded) {
    log().warn({ bucket, ip }, "auth rate limiter degraded to in-memory fallback (Redis unavailable)");
  }
  if (!result.allowed) {
    const res = fail({ code: "RATE_LIMITED", message: "Too many requests; please slow down", status: 429 });
    res.headers.set("Retry-After", String(result.retryAfterSeconds));
    return res;
  }
  return null;
}
