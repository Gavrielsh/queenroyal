import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { authRateLimit, clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "../lib/auth";
import { errBody, okBody } from "../lib/reply";
import { loginSchema, registerSchema } from "../schemas/auth.schema";
import { AuthError, loadClaims, login, mintAccessToken, register } from "../services/auth.service";
import { rotateRefreshToken, revokeRefreshToken, SessionStoreUnavailableError } from "../services/session.service";

/**
 * Auth perimeter (ported from the legacy Next.js `/api/auth/*` routes — Zone 3 is now UI-only).
 *
 * register/login are guarded by the STRICT, fail-closed Redis rate limiter (Phase 4): a dead
 * Redis returns 503, never an unthrottled brute-force surface. Refresh tokens are opaque,
 * single-use, HttpOnly-cookie-only secrets backed by Redis (see session.service); a Redis
 * outage on issue/rotate fails closed with 503 so a credential is never minted unrevocably.
 */
export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/auth/register", { preHandler: authRateLimit("register") }, registerHandler);
  app.post("/api/auth/login", { preHandler: authRateLimit("login") }, loginHandler);
  app.post("/api/auth/refresh", refreshHandler);
  app.post("/api/auth/logout", logoutHandler);
};

async function registerHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid registration payload", parsed.error.flatten()));
    return;
  }

  try {
    const result = await register(parsed.data);
    setRefreshCookie(reply, result.refreshToken);
    req.log.info({ user_id: result.user.id }, "registration succeeded");
    await reply.code(201).send(okBody({ user: result.user, accessToken: result.accessToken }));
  } catch (err) {
    await handleAuthError(req, reply, err, "registration");
  }
}

async function loginHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid login payload", parsed.error.flatten()));
    return;
  }

  try {
    const result = await login(parsed.data);
    setRefreshCookie(reply, result.refreshToken);
    req.log.info({ user_id: result.user.id }, "login succeeded");
    await reply.code(200).send(okBody({ user: result.user, accessToken: result.accessToken }));
  } catch (err) {
    await handleAuthError(req, reply, err, "login");
  }
}

/**
 * Exchange a valid refresh-token cookie for a new short-lived access token, ROTATING the
 * refresh token (single-use). Claims are reloaded from the DB so the new access token reflects
 * the latest KYC/VIP state.
 */
async function refreshHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[REFRESH_COOKIE];
  if (!token) {
    await reply.code(401).send(errBody("NO_REFRESH_TOKEN", "Missing refresh token"));
    return;
  }

  try {
    const rotated = await rotateRefreshToken(token);
    if (!rotated) {
      clearRefreshCookie(reply);
      await reply.code(401).send(errBody("INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired"));
      return;
    }
    const claims = await loadClaims(rotated.userId);
    const accessToken = mintAccessToken(claims);
    setRefreshCookie(reply, rotated.refreshToken);
    req.log.info({ user_id: rotated.userId }, "access token refreshed");
    await reply.code(200).send(okBody({ accessToken }));
  } catch (err) {
    if (err instanceof AuthError) {
      clearRefreshCookie(reply);
      await reply.code(err.status).send(errBody(err.code, err.message));
      return;
    }
    if (err instanceof SessionStoreUnavailableError) {
      req.log.error({ err }, "session store unavailable during refresh");
      await reply.code(503).send(errBody("SESSION_STORE_UNAVAILABLE", "Service temporarily unavailable"));
      return;
    }
    req.log.error({ err }, "unexpected error during refresh");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

/** Revoke the refresh session and clear the cookie. Idempotent. */
async function logoutHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[REFRESH_COOKIE];
  clearRefreshCookie(reply);

  if (token) {
    try {
      await revokeRefreshToken(token);
    } catch (err) {
      // The cookie is cleared regardless; a failed revoke (e.g. Redis blip) is logged but does
      // not block the client from logging out.
      req.log.warn({ err }, "refresh token revoke failed on logout");
    }
  }
  await reply.code(200).send(okBody({ loggedOut: true }));
}

/** Map a thrown auth/session error to the uniform JSON envelope + status. */
async function handleAuthError(
  req: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  flow: string,
): Promise<void> {
  if (err instanceof AuthError) {
    await reply.code(err.status).send(errBody(err.code, err.message));
    return;
  }
  if (err instanceof SessionStoreUnavailableError) {
    req.log.error({ err }, `session store unavailable during ${flow}`);
    await reply.code(503).send(errBody("SESSION_STORE_UNAVAILABLE", "Service temporarily unavailable"));
    return;
  }
  req.log.error({ err }, `unexpected error during ${flow}`);
  await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
}
