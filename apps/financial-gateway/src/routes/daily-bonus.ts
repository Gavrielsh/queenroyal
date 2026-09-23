import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { getEnv } from "../config/env";
import { requireAuth, UnauthorizedError } from "../lib/auth";
import { resolveJurisdiction } from "../lib/geo";
import { requirePermittedJurisdiction } from "../lib/geo-hook";
import { RateLimiterUnavailableError, rateLimit } from "../lib/rate-limit";
import { errBody, okBody } from "../lib/reply";
import { dailyBonusClaimSchema } from "../schemas/daily-bonus.schema";
import { claimDailyBonus, getDailyBonusStatus } from "../services/daily-bonus.service";

/**
 * The Daily Wheel.
 *
 *   GET  /api/bonus/daily        — the slices and their odds, today's availability, the streak.
 *   POST /api/bonus/daily/claim  — one server-drawn spin per gaming day.
 *
 * The claim route carries the AMOE perimeter (routes/amoe.ts) because it sits in front of the
 * same uncapped Zone 1 endpoint: jurisdiction fence first, then authentication, then per-account
 * and per-IP limits that FAIL CLOSED, then a strict body with no amount field at all. The daily
 * unique index in the service is the cap; everything here stops abuse before it.
 *
 * GET is authenticated (the streak is per player) but has no rate limit of its own beyond the
 * app-wide limiter: it reads, it issues nothing.
 */
export const dailyBonusRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/bonus/daily", { preHandler: [requireAuthPreHandler] }, statusHandler);
  app.post(
    "/api/bonus/daily/claim",
    { preHandler: [requirePermittedJurisdiction, requireAuthPreHandler, claimRateLimit] },
    claimHandler,
  );
};

async function requireAuthPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    req.authClaims = requireAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await reply.code(401).send(errBody("UNAUTHORIZED", err.message));
      return;
    }
    throw err;
  }
}

async function claimRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const env = getEnv();
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }
  const ip = req.ip || "unknown";
  try {
    const perAccount = await rateLimit(
      `bonus:daily:user:${user.sub}`,
      env.DAILY_BONUS_CLAIM_RATE_LIMIT_MAX,
      env.DAILY_BONUS_CLAIM_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!perAccount.allowed) {
      reply.header("retry-after", String(perAccount.retryAfterSeconds));
      await reply.code(429).send(errBody("RATE_LIMITED", "Too many spin attempts; please slow down"));
      return;
    }
    const perIp = await rateLimit(
      `bonus:daily:ip:${ip}`,
      env.DAILY_BONUS_CLAIM_IP_RATE_LIMIT_MAX,
      env.DAILY_BONUS_CLAIM_IP_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!perIp.allowed) {
      reply.header("retry-after", String(perIp.retryAfterSeconds));
      await reply.code(429).send(errBody("RATE_LIMITED", "Too many spin attempts; please slow down"));
      return;
    }
  } catch (err) {
    if (err instanceof RateLimiterUnavailableError) {
      req.log.error({ ip }, "daily bonus rate limiter unavailable (Redis down) — failing closed with 503");
      await reply.code(503).send(errBody("RATE_LIMITER_UNAVAILABLE", "Service temporarily unavailable"));
      return;
    }
    throw err;
  }
}

async function statusHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }
  try {
    await reply.code(200).send(okBody(await getDailyBonusStatus(user)));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error reading daily bonus status");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

async function claimHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }
  const parsed = dailyBonusClaimSchema.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid daily wheel claim", parsed.error.flatten()));
    return;
  }
  try {
    const outcome = await claimDailyBonus(user, parsed.data, {
      traceId: req.id,
      jurisdiction: resolveJurisdiction((name) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      }),
      ip: req.ip,
    });
    if (!outcome.ok) {
      await reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
      return;
    }
    await reply.code(200).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error processing daily bonus claim");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}
