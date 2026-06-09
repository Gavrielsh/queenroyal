import { Redis } from "ioredis";

import { getEnv } from "../config/env";
import { log } from "./logger";

/**
 * Shared Redis client (lazy process-singleton) for the long-running Fastify gateway.
 *
 * ── Topology (decided ONCE, on first use) ─────────────────────────────────────────────────
 *   • `REDIS_SENTINELS` non-empty → Sentinel-aware client (HIGH AVAILABILITY): ioredis discovers
 *                                   the current master named `REDIS_MASTER_NAME` from the
 *                                   sentinels and transparently follows it across failover.
 *   • else `REDIS_URL` set        → standalone client (single-node dev / simple deployments).
 *   • else                        → `null`.
 *
 * The routing config (sentinel list, master name, passwords) is parsed and STRICTLY VALIDATED by
 * the centralized `getEnv()` contract — this module never touches raw `process.env`, so a
 * malformed topology fails the boot rather than surfacing as a confusing runtime connection bug.
 *
 * ── Fail-closed contract ──────────────────────────────────────────────────────────────────
 * Callers on secure/financial paths (replay nonces, rate limiting) treat a `null` OR an
 * unreachable client as a HARD failure and reject with `503` — there is NO in-process fallback
 * for distributed state. `maxRetriesPerRequest` is kept low so a command FAILS FAST instead of
 * hanging, which lets the shared Redis circuit breaker trip and callers fail closed quickly.
 */

let client: Redis | null | undefined;

/** Fail fast (not forever) when Redis is unreachable, so the circuit breaker can fail closed. */
const MAX_RETRIES_PER_REQUEST = 2;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;

  const env = getEnv();

  // 1. Prefer the validated Sentinel topology when one is configured (HA path).
  if (env.REDIS_SENTINELS.length > 0) {
    client = attachListeners(
      new Redis({
        sentinels: [...env.REDIS_SENTINELS],
        name: env.REDIS_MASTER_NAME,
        role: "master",
        maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
        // Auth to the data nodes (master/replicas) and, when set, to the sentinels themselves.
        password: env.REDIS_PASSWORD,
        sentinelPassword: env.REDIS_SENTINEL_PASSWORD,
      }),
      "sentinel",
    );
    return client;
  }

  // 2. Fall back to a standalone connection.
  const url = env.REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }
  client = attachListeners(new Redis(url, { maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST }), "standalone");
  return client;
}

/**
 * Wire robust lifecycle listeners. The `error` listener is MANDATORY: without one, ioredis
 * surfaces connection/failover errors as an unhandled `'error'` event that crashes the process —
 * the opposite of fail-closed. The rest give operational visibility into reconnect/failover churn.
 */
function attachListeners(instance: Redis, mode: "sentinel" | "standalone"): Redis {
  instance.on("error", (err: unknown) => log().error({ err, mode }, "redis client error"));
  instance.on("connect", () => log().info({ mode }, "redis connecting"));
  instance.on("ready", () => log().info({ mode }, "redis ready"));
  instance.on("close", () => log().warn({ mode }, "redis connection closed"));
  instance.on("reconnecting", () => log().warn({ mode }, "redis reconnecting"));
  instance.on("end", () => log().warn({ mode }, "redis connection ended (no further reconnects)"));
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
