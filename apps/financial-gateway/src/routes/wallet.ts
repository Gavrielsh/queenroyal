import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth, UnauthorizedError } from "../lib/auth";
import { errBody, okBody } from "../lib/reply";
import { trueEngine } from "../lib/true-engine";
import { ProvisioningError, resolveTransactingPlayer } from "../services/player-provisioning.service";

/**
 * Read-only wallet mirror for Zone 3 (the Next.js frontend).
 *
 * The browser NEVER computes a balance: it calls this route, the route forwards the read to
 * the engine's signed POST /api/v1/session, and the engine's decimal-string balances are
 * returned VERBATIM (no parsing, no arithmetic, no caching). If the engine cannot vouch for
 * the numbers — timeout, 5xx, unreachable — the route FAILS CLOSED with 503 rather than
 * serving a stale or fabricated figure.
 */
export const walletRoutes: FastifyPluginAsync = async (app) => {
  // Sibling route plugins are encapsulated, so this plugin declares the decoration for its
  // own scope (the same pattern as routes/store.ts).
  app.decorateRequest("authClaims", null);
  app.get("/api/wallet", { preHandler: requireWalletAuth }, walletHandler);
};

async function requireWalletAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
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

async function walletHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  let player;
  try {
    player = await resolveTransactingPlayer(user.sub);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      req.log.error({ err, user_id: user.sub }, "wallet read: player provisioning failed");
      await reply.code(502).send(errBody("PROVISIONING_FAILED", "Could not resolve the player in the ledger"));
      return;
    }
    throw err;
  }

  const res = await trueEngine().getBalances({ player_id: player.trueEnginePlayerId });
  if (!res.ok) {
    // Fail closed: a balance we cannot verify is a balance we do not serve.
    if (res.status === 0 || res.status >= 500) {
      await reply.code(503).send(errBody("ENGINE_UNAVAILABLE", "The ledger is temporarily unavailable"));
      return;
    }
    if (res.status === 404) {
      await reply.code(404).send(errBody("PLAYER_NOT_FOUND", "Player is not known to the ledger"));
      return;
    }
    if (res.status === 403) {
      await reply.code(403).send(errBody(res.error.code, res.error.message));
      return;
    }
    // 401 here means OUR HMAC credentials were rejected — an integration fault, never the
    // player's; surface it as a gateway-side error and alert via logs.
    req.log.error({ engine_status: res.status, err_code: res.error.code }, "wallet read rejected by engine");
    await reply.code(502).send(errBody("ENGINE_REJECTED", "The ledger rejected the balance read"));
    return;
  }

  // Engine strings are forwarded verbatim — the gateway holds no opinion about money.
  await reply.code(200).send(okBody({ player_id: res.data.player_id, balances: res.data.balances }));
}
