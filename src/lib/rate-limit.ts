import type { Redis } from "ioredis";

import { withRedisBreaker } from "@/lib/circuit-breaker";
import { getRedis } from "@/lib/redis";

/**
 * Rate limiting with two explicit availability policies (Phase 2):
 *
 *   - {@link rateLimit} — STRICT / FAIL CLOSED. For financial and security-critical paths.
 *     If Redis is unconfigured, unreachable, or the breaker is open, it throws
 *     {@link RateLimiterUnavailableError} so the caller rejects the request (503). Unthrottled
 *     traffic must never reach those paths.
 *
 *   - {@link rateLimitDegraded} — GRACEFUL. For non-critical paths (e.g. auth login). It
 *     prefers the distributed Redis limiter, but when Redis is down it transparently falls
 *     back to a process-local, highly-restricted leaky bucket and keeps the gateway alive
 *     (`degraded: true`). It never throws for infrastructure failure.
 *
 * All Redis access goes through the shared circuit breaker, so a dead Redis is detected
 * once and fails FAST everywhere instead of stalling each request on driver retries.
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

export interface DegradedRateLimitResult extends RateLimitResult {
  /** True when the result came from the in-memory fallback (Redis was unavailable). */
  degraded: boolean;
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

/**
 * Like {@link rateLimit} but NEVER throws for infrastructure failure. On a Redis outage it
 * degrades to a strict in-memory leaky bucket (capacity `fallbackLimit`), so non-critical
 * routes stay available instead of 503-ing the whole gateway.
 */
export async function rateLimitDegraded(
  key: string,
  limit: number,
  windowSeconds: number,
  fallbackLimit: number,
): Promise<DegradedRateLimitResult> {
  const redis = getRedis();
  if (redis) {
    try {
      const result = await withRedisBreaker(() => redisFixedWindow(redis, key, limit, windowSeconds));
      return { ...result, degraded: false };
    } catch {
      // fall through to the in-memory fallback
    }
  }
  return { ...leakyBucket(key, fallbackLimit, windowSeconds), degraded: true };
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

// ── In-memory leaky-bucket fallback (degraded mode only) ───────────────────────
// Process-local, so it is NOT distributed — that's acceptable precisely because it is a
// last-resort fallback for NON-critical paths during a Redis outage. It is deliberately
// stricter (small capacity) so it can't become an open door.

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_BUCKETS = 10_000;

function leakyBucket(key: string, capacity: number, windowSeconds: number): RateLimitResult {
  const now = Date.now();
  const refillPerMs = capacity / (windowSeconds * 1000); // tokens regained per ms

  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_TRACKED_BUCKETS) pruneFullBuckets(capacity);
    bucket = { tokens: capacity, lastRefillMs: now };
    buckets.set(key, bucket);
  }

  // Leak in: refill tokens for the elapsed time, capped at capacity.
  const elapsed = now - bucket.lastRefillMs;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
  bucket.lastRefillMs = now;

  let allowed: boolean;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    allowed = true;
  } else {
    allowed = false;
  }

  const retryAfterSeconds = allowed ? 0 : Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
  return {
    allowed,
    limit: capacity,
    remaining: Math.max(0, Math.floor(bucket.tokens)),
    retryAfterSeconds,
  };
}

/** Drop fully-refilled (idle) buckets to bound memory during a prolonged outage. */
function pruneFullBuckets(capacity: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.tokens >= capacity) buckets.delete(key);
  }
}

/** Test seam: clear the in-memory buckets between cases. */
export function __resetInMemoryBuckets(): void {
  buckets.clear();
}
