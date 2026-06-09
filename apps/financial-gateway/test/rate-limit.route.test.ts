import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";

/**
 * Task 1 — global @fastify/rate-limit enforcement. With no REDIS_URL in the test env the plugin
 * uses its in-memory store (single process), which is enough to prove the wiring: requests are
 * counted per-IP, the breach returns a standard 429 in the gateway envelope with Retry-After, and
 * the allow-listed liveness probe is never throttled.
 */
describe("global rate limiting (@fastify/rate-limit)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = "3";
    process.env.RATE_LIMIT_WINDOW_SECONDS = "60";
    resetEnvCacheForTests();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_SECONDS;
    resetEnvCacheForTests();
    await app.close();
  });

  it("allows up to the configured max, then returns 429 with Retry-After", async () => {
    // A real, non-allow-listed route. Unauthenticated → 401 (rejected by auth, NOT the limiter)
    // for the first `max` requests, proving the limiter let them through.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "POST", url: "/api/store/purchase" });
      expect(res.statusCode).toBe(401);
    }

    // The next request breaches the limit before the route's auth check even runs.
    const limited = await app.inject({ method: "POST", url: "/api/store/purchase" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("never throttles the allow-listed health probe", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
    }
  });
});
