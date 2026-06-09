import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";

import { getEnv } from "../config/env";
import { verifyAccessToken, type AuthClaims } from "./jwt";
import { rateLimit, RateLimiterUnavailableError } from "./rate-limit";
import { errBody } from "./reply";

/** Name of the HttpOnly refresh-token cookie. Scoped to the auth routes only. */
export const REFRESH_COOKIE = "qr_refresh_token";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Cookie attributes for the refresh token. `Secure` in production, `SameSite=Strict`, and a
 * `path` scoped to `/api/auth` so it is only ever sent to the auth endpoints (login/refresh/
 * logout) — never attached to ordinary API calls.
 */
function refreshCookieOptions(maxAge: number): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: getEnv().NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth",
    maxAge,
  };
}

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, refreshCookieOptions(getEnv().JWT_REFRESH_TTL_SECONDS));
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0));
}

/**
 * Extract and verify the Bearer token from a request, returning the player's claims. Throws
 * {@link UnauthorizedError} on any missing/malformed/invalid token. Token verification uses
 * `jsonwebtoken` (Node crypto) — never an edge runtime.
 */
export function requireAuth(req: FastifyRequest): AuthClaims {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedError("Empty bearer token");
  }

  try {
    return verifyAccessToken(token);
  } catch {
    throw new UnauthorizedError("Invalid or expired token");
  }
}

/**
 * Build a preHandler that enforces the auth rate limit for `bucket` (e.g. "login") keyed by
 * the client IP (`req.ip`, resolved from X-Forwarded-* because the app trusts the proxy).
 *
 * STRICT / FAIL CLOSED (Phase 4): the auth surface is brute-force-sensitive, so it relies
 * EXCLUSIVELY on the distributed Redis limiter — there is NO process-local fallback. If Redis
 * is unreachable (or the shared breaker is open) the limiter cannot vouch for the request, so
 * we refuse it with `503 Service Unavailable` rather than silently weakening brute-force
 * protection. Over-limit → 429 with `Retry-After`.
 */
export function authRateLimit(bucket: string): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const env = getEnv();
    const ip = req.ip || "unknown";

    let result;
    try {
      result = await rateLimit(`auth:${bucket}:${ip}`, env.AUTH_RATE_LIMIT_MAX, env.AUTH_RATE_LIMIT_WINDOW_SECONDS);
    } catch (err) {
      if (err instanceof RateLimiterUnavailableError) {
        req.log.error({ bucket, ip }, "auth rate limiter unavailable (Redis down) — failing closed with 503");
        await reply.code(503).send(errBody("RATE_LIMITER_UNAVAILABLE", "Service temporarily unavailable"));
        return;
      }
      throw err;
    }

    if (!result.allowed) {
      reply.header("retry-after", String(result.retryAfterSeconds));
      await reply.code(429).send(errBody("RATE_LIMITED", "Too many requests; please slow down"));
    }
  };
}
