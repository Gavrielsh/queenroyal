import { Redis } from "ioredis";

import { getEnv } from "../config/env";
import { log } from "./logger";

/**
 * Shared Redis client (lazy singleton for the long-running process). Returns `null` when
 * `REDIS_URL` is not configured; callers on financial/secure paths (replay protection) treat
 * a `null`/unreachable client as a hard failure and reject with 503 — there is NO in-process
 * fallback for distributed state. Fail closed, always.
 */

let client: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;

  const url = getEnv().REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }

  const instance = new Redis(url, {
    // Don't queue forever if Redis is unreachable — fail the command so replay protection
    // fails CLOSED (via the circuit breaker) rather than hanging the request.
    maxRetriesPerRequest: 2,
  });
  instance.on("error", (err: unknown) => {
    log().error({ err }, "redis client error");
  });

  client = instance;
  return instance;
}

/** Close the Redis connection on graceful shutdown. Safe no-op if never constructed. */
export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  const instance = client;
  client = undefined;
  try {
    await instance.quit();
  } catch {
    instance.disconnect();
  }
}
