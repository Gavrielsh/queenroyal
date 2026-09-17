import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth, UnauthorizedError } from "../lib/auth";
import { resolveJurisdiction } from "../lib/geo";
import { requirePermittedJurisdiction } from "../lib/geo-hook";
import type { AuthClaims } from "../lib/jwt";
import { errBody, okBody } from "../lib/reply";
import { redeemSchema } from "../schemas/redeem.schema";
import { mockConfirmSchema, purchaseSchema } from "../schemas/store.schema";
import { requestRedemption } from "../services/redemption.service";
import { confirmMockDeposit, purchasePackage } from "../services/store.service";

/** Per-request authenticated claims, populated by the auth preHandler BEFORE the controller. */
declare module "fastify" {
  interface FastifyRequest {
    authClaims: AuthClaims | null;
  }
}

/**
 * Cashier perimeter (ported from the legacy Next.js `/api/store/*` routes).
 *
 * The single mutating route requires a verified Bearer access token (the preHandler rejects an
 * unauthenticated request with 401 BEFORE the controller). The handler then validates the body
 * with the SAME Zod schema as the legacy route and delegates to the unchanged async cashier
 * service (open PSP intent → journal PENDING deposit → schedule lost-webhook backstop).
 */
export const storeRoutes: FastifyPluginAsync = async (app) => {
  app.decorateRequest("authClaims", null);
  // Jurisdiction FIRST: a player in a prohibited state must not be able to
  // open a payment intent, let alone be charged.
  app.post(
    "/api/store/purchase",
    { preHandler: [requirePermittedJurisdiction, requireAuthPreHandler] },
    purchaseHandler,
  );
  // Money OUT. Same two preHandlers, same order, and for the same reason: a player in a
  // prohibited state must not be able to move money in either direction.
  app.post(
    "/api/store/redeem",
    { preHandler: [requirePermittedJurisdiction, requireAuthPreHandler] },
    redeemHandler,
  );
  // DEV-ONLY: stands in for the Stripe.js card confirmation + `succeeded` webhook when the
  // mock PSP is active. Responds 409 MOCK_PSP_ONLY under a real provider (see the service).
  app.post("/api/store/purchase/mock-confirm", { preHandler: requireAuthPreHandler }, mockConfirmHandler);
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

async function purchaseHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid purchase payload", parsed.error.flatten()));
    return;
  }

  try {
    const outcome = await purchasePackage(user, parsed.data, { traceId: req.id });
    if (!outcome.ok) {
      await reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
      return;
    }
    await reply.code(200).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error processing purchase");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

/**
 * POST /api/store/redeem — request a prize payout.
 *
 * Structurally identical to purchaseHandler: authenticate, validate with Zod, delegate, map
 * the service's typed outcome onto a status code. The handler contains no policy of its own —
 * every rule lives in lib/redemption-policy, which is the only place it can be audited.
 */
async function redeemHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    // A native JSON number for `amount` lands here, before the service and long before the
    // ledger: z.string() refuses it on type.
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid redemption payload", parsed.error.flatten()));
    return;
  }

  try {
    const outcome = await requestRedemption(user, parsed.data, {
      traceId: req.id,
      jurisdiction: resolveJurisdiction((name) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      }),
    });
    if (!outcome.ok) {
      await reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
      return;
    }
    await reply.code(200).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error processing redemption");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

async function mockConfirmHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  const parsed = mockConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid mock-confirm payload", parsed.error.flatten()));
    return;
  }

  try {
    const outcome = await confirmMockDeposit(user, parsed.data, { traceId: req.id });
    if (!outcome.ok) {
      await reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
      return;
    }
    await reply.code(200).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error processing mock confirmation");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}
