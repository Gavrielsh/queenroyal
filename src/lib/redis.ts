import { Redis } from "ioredis";

import { getEnv } from "@/lib/env";

/**
 * Shared Redis client (lazy singleton, reused across hot reloads / serverless
 * invocations). Returns `null` when `REDIS_URL` is not configured, so callers can pick a
 * process-local fallback in development while production wires a real distributed store.
 */
const globalForRedis = globalThis as unknown as { redis?: Redis | null };

export function getRedis(): Redis | null {
  if (globalForRedis.redis !== undefined) return globalForRedis.redis;

  const url = getEnv().REDIS_URL;
  if (!url) {
    globalForRedis.redis = null;
    return null;
  }

  const client = new Redis(url, {
    // Don't queue forever if Redis is unreachable — fail the command so replay
    // protection fails CLOSED rather than hanging the request.
    maxRetriesPerRequest: 2,
  });
  client.on("error", (err: unknown) => {
    console.error("[redis] client error", err instanceof Error ? err.message : err);
  });

  globalForRedis.redis = client;
  return client;
}
