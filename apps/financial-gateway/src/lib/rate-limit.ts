import type { Redis } from "ioredis";

import { withRedisBreaker } from "./circuit-breaker";
import { getRedis } from "./redis";

/**
 * Distributed rate limiting — STRICT / FAIL CLOSED (Phase 4).
 *
 * There is exactly ONE availability policy: the limiter is backed solely by Redis. There is
 * NO process-local (`Map`/`Set`) leaky-bucket fallback and NO "graceful degradation". If
 * Redis is unconfigured, unreachable, or the shared circuit breaker is open, {@link rateLimit}
 * throws {@link RateLimiterUnavailableError} so the caller rejects the request with
 * `503 Service Unavailable`. Unthrottled traffic must never reach a protected path — not even
 * the auth/login surface — so a dead Redis fails the request closed rather than admitting it
 * against untracked, process-local state.
 *
 * All Redis access goes through the shared circuit breaker, so a dead Redis is detected once
 * and fails FAST everywhere instead of stalling each request on driver retries.
 */

export class RateLimiterUnavailableError extends Error {
  constructor(message = "rate limiter unavailable") {
    super(message);
    this.name = "RateLimiterUnavailableError";
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

const KEY_PREFIX = "ratelimit:";

/**
 * Count a hit against `key` within a fixed Redis window. FAIL CLOSED: throws
 * {@link RateLimiterUnavailableError} when Redis is absent/unreachable or the breaker is open.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) throw new RateLimiterUnavailableError("REDIS_URL is required for rate limiting");
  try {
    return await withRedisBreaker(() => redisFixedWindow(redis, key, limit, windowSeconds));
  } catch (err) {
    // Breaker-open or any Redis error → unavailable. Fail closed.
    throw new RateLimiterUnavailableError(err instanceof Error ? err.message : "rate limiter unavailable");
  }
}

/** Redis fixed-window counter. First hit in a window sets the TTL; later hits increment. */
async function redisFixedWindow(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redisKey = `${KEY_PREFIX}${key}`;
  const count = await redis.incr(redisKey);
  let ttl: number;
  if (count === 1) {
    await redis.expire(redisKey, windowSeconds);
    ttl = windowSeconds;
  } else {
    ttl = await redis.ttl(redisKey);
    // A missing/!expiring key (-1) shouldn't happen after the first INCR; reset defensively.
    if (ttl < 0) {
      await redis.expire(redisKey, windowSeconds);
      ttl = windowSeconds;
    }
  }

  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: ttl,
  };
}
