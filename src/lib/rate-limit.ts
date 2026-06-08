import { getRedis } from "@/lib/redis";

/**
 * Redis-backed fixed-window rate limiter. Distributed (shared across all instances) and
 * FAIL CLOSED: if Redis is not configured or unreachable, callers must reject the request
 * (treating the limiter as unavailable) rather than letting unthrottled traffic through.
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
 * Count a hit against `key` within a fixed window. The first hit in a window sets the
 * window TTL; subsequent hits increment the counter. Throws
 * {@link RateLimiterUnavailableError} when Redis is absent (fail closed).
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) throw new RateLimiterUnavailableError("REDIS_URL is required for rate limiting");

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
