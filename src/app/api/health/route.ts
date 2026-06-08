import { NextResponse } from "next/server";

import { redisCircuitBreaker } from "@/lib/circuit-breaker";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness/health probe — a NON-financial route that MUST stay alive even when Redis is
 * down (Phase 2). It never touches Redis on the request path and never 503s on a Redis
 * outage; it simply reports the shared circuit breaker's view so operators can see
 * degradation without the gateway falling over. Reading the breaker state is non-blocking.
 */
export function GET() {
  // Fully defensive: a health probe must NEVER throw — not on a Redis outage, not on a
  // misconfigured env. Any failure to read state degrades to "unknown", still 200.
  let redisConfigured = false;
  let circuitState = "unknown";
  try {
    redisConfigured = Boolean(getEnv().REDIS_URL);
    circuitState = redisCircuitBreaker().snapshot().state;
  } catch {
    redisConfigured = false;
    circuitState = "unknown";
  }

  // The gateway is "ok" for liveness regardless of Redis; `redis.healthy` reflects whether
  // the distributed store is currently usable (breaker not open).
  const redisHealthy = !redisConfigured ? null : circuitState !== "open";

  return NextResponse.json({
    success: true,
    data: {
      status: "ok",
      service: "gateway-cashier",
      dependencies: {
        redis: {
          configured: redisConfigured,
          healthy: redisHealthy,
          circuit: circuitState,
        },
      },
    },
  });
}
