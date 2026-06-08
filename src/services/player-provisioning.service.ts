import { prisma } from "@/lib/prisma";
import { trueEngine } from "@/lib/true-engine";

/**
 * Identity bridge: our `User.id` is the engine's `external_id`, but the engine
 * addresses players by its OWN `player_id`. We provision via POST /api/v1/player/create
 * (idempotent on external_id) and persist the returned id on `User.trueEnginePlayerId`.
 */

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/**
 * Return the engine `player_id` for a local user, provisioning lazily (and persisting)
 * if we don't have it yet. Self-healing: createPlayer is idempotent, so calling it for
 * an already-provisioned external_id simply returns the existing player.
 */
export async function resolveTrueEnginePlayerId(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, trueEnginePlayerId: true },
  });
  if (!user) throw new ProvisioningError(`Unknown user ${userId}`);
  if (user.trueEnginePlayerId) return user.trueEnginePlayerId;
  return provisionTrueEnginePlayer(user.id, user.email);
}

/**
 * Provision a local user in the engine and persist the returned `player_id`. Safe to
 * call repeatedly (idempotent on external_id). Throws {@link ProvisioningError} if the
 * engine rejects provisioning.
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
  await prisma.user.update({
    where: { id: userId },
    data: { trueEnginePlayerId: playerId },
  });
  return playerId;
}
