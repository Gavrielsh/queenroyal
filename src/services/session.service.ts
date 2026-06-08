import { createHash, randomBytes } from "node:crypto";

import { getEnv } from "@/lib/env";
import { getRedis } from "@/lib/redis";

/**
 * Refresh-token sessions, backed by Redis. The refresh token is an opaque high-entropy
 * secret delivered to the client only as an HttpOnly cookie; Redis stores just its SHA-256
 * hash → session metadata, with a TTL equal to the refresh lifetime. Rotation invalidates
 * the old token on every use; logout (revoke) deletes it. Access tokens stay short-lived
 * and stateless.
 *
 * FAIL CLOSED: if Redis is unavailable, session issuance/rotation throws — auth cannot
 * silently degrade into an unrevocable, long-lived credential.
 */

export class SessionStoreUnavailableError extends Error {
  constructor(message = "session store unavailable") {
    super(message);
    this.name = "SessionStoreUnavailableError";
  }
}

const KEY_PREFIX = "refresh:";

interface SessionRecord {
  userId: string;
  createdAt: number;
}

function requireRedis() {
  const redis = getRedis();
  if (!redis) throw new SessionStoreUnavailableError("REDIS_URL is required for refresh sessions");
  return redis;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function keyFor(token: string): string {
  return `${KEY_PREFIX}${hashToken(token)}`;
}

/** Issue a fresh opaque refresh token bound to a user, stored hashed with the refresh TTL. */
export async function issueRefreshToken(userId: string): Promise<string> {
  const redis = requireRedis();
  const ttl = getEnv().JWT_REFRESH_TTL_SECONDS;
  const token = randomBytes(32).toString("hex");
  const record: SessionRecord = { userId, createdAt: Date.now() };
  await redis.set(keyFor(token), JSON.stringify(record), "EX", ttl);
  return token;
}

/**
 * Validate and ROTATE a refresh token: the presented token is consumed (deleted) and a
 * brand-new one is issued for the same user. Returns null if the token is unknown/expired
 * (reuse of a rotated token therefore fails closed).
 */
export async function rotateRefreshToken(token: string): Promise<{ userId: string; refreshToken: string } | null> {
  const redis = requireRedis();
  const key = keyFor(token);
  const raw = await redis.get(key);
  if (!raw) return null;

  let record: SessionRecord;
  try {
    record = JSON.parse(raw) as SessionRecord;
  } catch {
    await redis.del(key);
    return null;
  }

  await redis.del(key); // single-use: invalidate the presented token
  const refreshToken = await issueRefreshToken(record.userId);
  return { userId: record.userId, refreshToken };
}

/** Revoke a refresh token (logout). Idempotent. */
export async function revokeRefreshToken(token: string): Promise<void> {
  const redis = requireRedis();
  await redis.del(keyFor(token));
}
