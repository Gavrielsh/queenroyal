import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { getAmoeInstructions } from "../config/amoe";
import { requireAuth, UnauthorizedError } from "../lib/auth";
import { getEnv } from "../config/env";
import { resolveJurisdiction } from "../lib/geo";
import { requirePermittedJurisdiction } from "../lib/geo-hook";
import { RateLimiterUnavailableError, rateLimit } from "../lib/rate-limit";
import { errBody, okBody } from "../lib/reply";
import { amoeClaimSchema } from "../schemas/amoe.schema";
import { claimAmoeGrant } from "../services/amoe.service";

/**
 * NO PURCHASE NECESSARY — the statutory free entry method.
 *
 * Two routes with deliberately opposite perimeters, and the asymmetry is the point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/amoe — UNAUTHENTICATED, ON PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * A free entry method that can only be discovered from inside a logged-in account is not
 * meaningfully available. "No purchase necessary" has to be readable by someone who has not
 * purchased — including a regulator with no account at all, and a prospective player deciding
 * whether the offer is real before handing over an email address. Putting auth on this route
 * would be a compliance defect wearing the costume of a security control.
 *
 * It is also outside the jurisdiction fence. Telling someone in a state where the sweepstakes
 * is not offered that it is not offered there is information they are entitled to; refusing to
 * serve them the terms would be the same mistake one layer up. The route discloses; it issues
 * nothing.
 *
 * It reads no request data, touches no database, and returns a constant, so there is nothing
 * to abuse beyond bandwidth — which the app-wide per-IP limiter in app.ts already bounds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/amoe/claim — THE MOST HEAVILY GUARDED ROUTE IN THE GATEWAY
 * ─────────────────────────────────────────────────────────────────────────────
 * It dispatches to a Zone 1 endpoint that applies NO frequency cap of its own: the ledger
 * issues what an authenticated operator asks it to. Everything between the public internet and
 * unbounded free-coin issuance is here and in the service behind it, stacked deepest-last:
 *
 *   1. Jurisdiction fence — an entry must not be offered where the sweepstakes is not.
 *   2. Authentication — a claim is against a specific account or it is nothing.
 *   3. Per-account rate limit (fail closed).
 *   4. Per-IP rate limit (fail closed) — the multi-accounting signal.
 *   5. Strict body schema with NO money field of any kind.
 *   6. The policy gate, then the `(userId, grantPeriod)` unique index, in the service.
 *
 * The rate limits run AFTER authentication so the per-account key is a verified subject rather
 * than a client-asserted one, and the fence runs first so a prohibited jurisdiction is refused
 * before any of it — the same order the store routes use, for the same reason.
 */
export const amoeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/amoe", instructionsHandler);

  app.post(
    "/api/amoe/claim",
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

/**
 * Two independent fixed windows — one per account, one per address — both FAIL CLOSED.
 *
 * Fail-closed is the right direction on this specific route even though it is the one route
 * whose availability has a compliance dimension. The endpoint behind it is unbounded, so an
 * unthrottled claim path is an issuance hole; a brief outage of the claim button is a support
 * ticket, and the mailing address in `GET /api/amoe` remains a working entry method
 * throughout. The disclosure route stays up regardless — it has no Redis dependency.
 *
 * The per-IP limit is deliberately the looser of the two. An address is shared by households,
 * offices and carrier NAT, so a tight one would refuse a statutory free entry to everyone
 * behind a single gateway — denying legitimate entrants to inconvenience a fraudster who can
 * change addresses more easily than a real player can.
 */
async function claimRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const env = getEnv();
  const user = req.authClaims;
  // Unreachable in the configured chain (auth runs first and 401s), but the limiter must not
  // silently degrade to an IP-only guard if that order is ever changed.
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }
  const ip = req.ip || "unknown";

  try {
    const perAccount = await rateLimit(
      `amoe:claim:user:${user.sub}`,
      env.AMOE_CLAIM_RATE_LIMIT_MAX,
      env.AMOE_CLAIM_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!perAccount.allowed) {
      reply.header("retry-after", String(perAccount.retryAfterSeconds));
      await reply.code(429).send(errBody("RATE_LIMITED", "Too many free-entry claims; please slow down"));
      return;
    }

    const perIp = await rateLimit(
      `amoe:claim:ip:${ip}`,
      env.AMOE_CLAIM_IP_RATE_LIMIT_MAX,
      env.AMOE_CLAIM_IP_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!perIp.allowed) {
      reply.header("retry-after", String(perIp.retryAfterSeconds));
      // The SAME opaque body as the per-account refusal. A distinct code here would tell a
      // probing client which of the two limits it hit, and therefore how many accounts it may
      // drive from one address before the address itself is the binding constraint.
      await reply.code(429).send(errBody("RATE_LIMITED", "Too many free-entry claims; please slow down"));
      return;
    }
  } catch (err) {
    if (err instanceof RateLimiterUnavailableError) {
      req.log.error({ ip }, "amoe claim rate limiter unavailable (Redis down) — failing closed with 503");
      await reply.code(503).send(errBody("RATE_LIMITER_UNAVAILABLE", "Service temporarily unavailable"));
      return;
    }
    throw err;
  }
}

/**
 * GET /api/amoe — the statutory disclosure.
 *
 * A constant from config, served with a cache header: the terms change by legal review, not by
 * request, and a route whose whole purpose is to always be readable should not depend on this
 * process being reachable for every view.
 */
async function instructionsHandler(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header("cache-control", "public, max-age=300");
  await reply.code(200).send(okBody(getAmoeInstructions()));
}

async function claimHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  const parsed = amoeClaimSchema.safeParse(req.body);
  if (!parsed.success) {
    // `.strict()` lands an unexpected key here — including a hopeful `sc_amount`. The claimant
    // does not choose the grant size; refusing loudly beats ignoring the field and letting the
    // client believe it worked.
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid free-entry claim", parsed.error.flatten()));
    return;
  }

  try {
    const outcome = await claimAmoeGrant(user, parsed.data, {
      traceId: req.id,
      jurisdiction: resolveJurisdiction((name) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      }),
      // Fraud review only — never an authorization input. See FlowContext.ip.
      ip: req.ip,
    });
    if (!outcome.ok) {
      await reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
      return;
    }
    await reply.code(200).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error processing amoe claim");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}
