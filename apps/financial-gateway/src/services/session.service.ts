import { createHash, randomBytes } from "node:crypto";

import type { Redis } from "ioredis";

import { getEnv } from "../config/env";
import { withRedisBreaker } from "../lib/circuit-breaker";
import { getRedis } from "../lib/redis";

/**
 * Refresh-token sessions, backed by Redis. The refresh token is an opaque high-entropy secret
 * delivered to the client only as an HttpOnly cookie; Redis stores just its SHA-256 hash →
 * session metadata, with a TTL equal to the refresh lifetime. Rotation invalidates the old
 * token on every use; logout (revoke) deletes it. Access tokens stay short-lived and stateless.
 *
 * FAIL CLOSED: if Redis is unavailable, session issuance/rotation throws — auth cannot silently
 * degrade into an unrevocable, long-lived credential.
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

/**
 * Run a refresh-session Redis op through the shared circuit breaker. FAIL CLOSED: a
 * missing/unreachable store (or an open breaker) surfaces as {@link SessionStoreUnavailableError}
 * so auth never silently degrades into issuing an unrevocable, long-lived credential. The
 * breaker makes that rejection FAST instead of hanging on driver retries.
 */
async function withSessionStore<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = getRedis();
  if (!redis) throw new SessionStoreUnavailableError("REDIS_URL is required for refresh sessions");
  try {
    return await withRedisBreaker(() => fn(redis));
  } catch (err) {
    if (err instanceof SessionStoreUnavailableError) throw err;
    throw new SessionStoreUnavailableError(err instanceof Error ? err.message : "session store unavailable");
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function keyFor(token: string): string {
  return `${KEY_PREFIX}${hashToken(token)}`;
}

/** Issue a fresh opaque refresh token bound to a user, stored hashed with the refresh TTL. */
export async function issueRefreshToken(userId: string): Promise<string> {
  const ttl = getEnv().JWT_REFRESH_TTL_SECONDS;
  const token = randomBytes(32).toString("hex");
  const record: SessionRecord = { userId, createdAt: Date.now() };
  await withSessionStore((redis) => redis.set(keyFor(token), JSON.stringify(record), "EX", ttl));
  return token;
}

/**
 * Validate and ROTATE a refresh token: the presented token is consumed (deleted) and a
 * brand-new one is issued for the same user. Returns null if the token is unknown/expired
 * (reuse of a rotated token therefore fails closed).
 */
export async function rotateRefreshToken(token: string): Promise<{ userId: string; refreshToken: string } | null> {
  const key = keyFor(token);
  const raw = await withSessionStore((redis) => redis.get(key));
  if (!raw) return null;

  let record: SessionRecord;
  try {
    record = JSON.parse(raw) as SessionRecord;
  } catch {
    await withSessionStore((redis) => redis.del(key));
    return null;
  }

  await withSessionStore((redis) => redis.del(key)); // single-use: invalidate the presented token
  const refreshToken = await issueRefreshToken(record.userId);
  return { userId: record.userId, refreshToken };
}

/** Revoke a refresh token (logout). Idempotent. */
export async function revokeRefreshToken(token: string): Promise<void> {
  await withSessionStore((redis) => redis.del(keyFor(token)));
}
