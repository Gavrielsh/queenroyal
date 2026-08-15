import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth, UnauthorizedError } from "../lib/auth";
import type { AuthClaims } from "../lib/jwt";
import { errBody, okBody } from "../lib/reply";
import { spinSchema } from "../schemas/spin.schema";
import { processPlayerSpin } from "../services/spin.service";

declare module "fastify" {
  interface FastifyRequest {
    authClaims: AuthClaims | null;
  }
}

/**
 * Player game perimeter — the SERVER-AUTHORITATIVE spin.
 *
 * Requires a verified Bearer access token. The body carries a stake, a currency, a game id,
 * and an idempotency key. It carries NO win amount: the engine draws the outcome and derives
 * the payout, so there is nothing here a player can inflate.
 *
 * This route replaces the player-facing use of the B2B webhook, whose caller-supplied
 * `win_amount` was the audit's most severe finding.
 */
export const spinRoutes: FastifyPluginAsync = async (app) => {
  app.decorateRequest("authClaims", null);
  app.post("/api/spin", { preHandler: requireAuthPreHandler }, spinHandler);
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

async function spinHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  const parsed = spinSchema.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid spin payload", parsed.error.flatten()));
    return;
  }

  try {
    const outcome = await processPlayerSpin(user, parsed.data, { traceId: req.id });
    if (!outcome.ok) {
      await reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
      return;
    }
    await reply.code(200).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error processing spin");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}
