import { getPrisma } from "../lib/prisma";
import { trueEngine } from "../lib/true-engine";

/**
 * Identity bridge: our `User.id` is the engine's `external_id`, but the engine addresses
 * players by its OWN `player_id`. We provision via POST /api/v1/player/create (idempotent on
 * external_id) and persist the returned id on `User.trueEnginePlayerId`.
 */

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/** The fields a money-mutating path needs: the engine player id + the CURRENT KYC status. */
export interface TransactingPlayer {
  userId: string;
  kycStatus: string;
  trueEnginePlayerId: string;
}

/**
 * Resolve everything a money path needs in a single read: the engine `player_id` (provisioning
 * lazily and persisting if absent) and the player's current KYC status (sourced from the DB,
 * never from a stale JWT claim).
 */
export async function resolveTransactingPlayer(userId: string): Promise<TransactingPlayer> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, kycStatus: true, trueEnginePlayerId: true },
  });
  if (!user) throw new ProvisioningError(`Unknown user ${userId}`);

  const trueEnginePlayerId = user.trueEnginePlayerId ?? (await provisionTrueEnginePlayer(user.id, user.email));
  return { userId: user.id, kycStatus: user.kycStatus, trueEnginePlayerId };
}

/**
 * Provision a local user in the engine and persist the returned `player_id`. Safe to call
 * repeatedly (idempotent on external_id). Throws {@link ProvisioningError} if the engine
 * rejects provisioning.
 */
export async function provisionTrueEnginePlayer(userId: string, email?: string | null): Promise<string> {
  const res = await trueEngine().createPlayer({
    external_id: userId,
    ...(email ? { email } : {}),
  });
  if (!res.ok) {
    throw new ProvisioningError(`player/create failed: ${res.error.code} — ${res.error.message}`);
  }
  const playerId = res.data.player_id;
  await getPrisma().user.update({
    where: { id: userId },
    data: { trueEnginePlayerId: playerId },
  });
  return playerId;
}
