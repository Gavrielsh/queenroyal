import { Redis, type RedisOptions } from "ioredis";

import { getEnv } from "../config/env";
import { log } from "./logger";

/**
 * Shared Redis client (lazy process-singleton) for the long-running Fastify gateway.
 *
 * ── Topology (decided ONCE, on first use) ─────────────────────────────────────────────────
 *   • `REDIS_SENTINELS` set  → Sentinel-aware client (HIGH AVAILABILITY): ioredis discovers the
 *                              current master named `REDIS_MASTER_NAME` from the sentinels and
 *                              transparently follows it across failover.
 *   • else `REDIS_URL` set   → standalone client (single-node dev / simple deployments).
 *   • else                   → `null`.
 *
 * ── Fail-closed contract (unchanged) ──────────────────────────────────────────────────────
 * Callers on secure/financial paths (replay nonces, rate limiting) treat a `null` OR an
 * unreachable client as a HARD failure and reject with `503` — there is NO in-process fallback
 * for distributed state. `maxRetriesPerRequest` is kept low so a command FAILS FAST instead of
 * hanging, which lets the shared Redis circuit breaker trip and callers fail closed quickly.
 *
 * ── Why this reads `process.env` directly ─────────────────────────────────────────────────
 * The Sentinel topology is a BOOTSTRAP decision about how to construct the client itself,
 * evaluated before any request is served, so it is read straight from `process.env` rather than
 * the per-request Zod `getEnv()` contract. The standalone fallback still uses validated env.
 */

let client: Redis | null | undefined;

const DEFAULT_MASTER_NAME = "qrmaster";
const DEFAULT_SENTINEL_PORT = 26379;
/** Fail fast (not forever) when Redis is unreachable, so the circuit breaker can fail closed. */
const MAX_RETRIES_PER_REQUEST = 2;

interface SentinelNode {
  host: string;
  port: number;
}

export function getRedis(): Redis | null {
  if (client !== undefined) return client;

  // 1. Prefer a Sentinel topology when one is configured (HA path).
  const sentinels = parseSentinels(process.env.REDIS_SENTINELS);
  if (sentinels.length > 0) {
    client = attachListeners(new Redis(buildSentinelOptions(sentinels)), "sentinel");
    return client;
  }

  // 2. Fall back to a standalone connection (validated env).
  const url = getEnv().REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }
  client = attachListeners(new Redis(url, { maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST }), "standalone");
  return client;
}

/** Build the ioredis options for a Sentinel-aware client. */
function buildSentinelOptions(sentinels: SentinelNode[]): RedisOptions {
  return {
    sentinels,
    name: process.env.REDIS_MASTER_NAME ?? DEFAULT_MASTER_NAME,
    role: "master",
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    // Auth to the data nodes (master/replicas) and, when set, to the sentinels themselves.
    // Left undefined when unset (exactOptionalPropertyTypes is off → ioredis simply skips them).
    password: process.env.REDIS_PASSWORD,
    sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD,
  };
}

/**
 * Parse `REDIS_SENTINELS` of the form `host:port,host:port,…` (port optional → 26379) into the
 * ioredis sentinel list. Malformed entries are skipped (logged) rather than constructing a
 * broken topology; an unset/blank value yields `[]` (no Sentinel topology configured).
 */
function parseSentinels(raw: string | undefined): SentinelNode[] {
  if (!raw) return [];

  const nodes: SentinelNode[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    // Split on the LAST colon so bracketless IPv6 isn't mis-parsed for the common host:port case.
    const sep = trimmed.lastIndexOf(":");
    if (sep <= 0) {
      nodes.push({ host: trimmed, port: DEFAULT_SENTINEL_PORT });
      continue;
    }

    const host = trimmed.slice(0, sep).trim();
    const port = Number.parseInt(trimmed.slice(sep + 1).trim(), 10);
    if (host === "" || !Number.isInteger(port) || port <= 0 || port > 65535) {
      log().warn({ entry: trimmed }, "ignoring malformed REDIS_SENTINELS entry");
      continue;
    }
    nodes.push({ host, port });
  }
  return nodes;
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
