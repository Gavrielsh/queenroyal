import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";

/**
 * Phase 1 smoke tests. They assert the liveness contract and the uniform 404 envelope using
 * `app.inject()` — no socket, no DB, no Redis — exactly mirroring how the probe must behave in
 * production.
 */
describe("financial-gateway: app", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/health → 200 liveness, no external dependency", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("financial-gateway");
    expect(typeof body.uptime_s).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("unknown route → 404 with a JSON error envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("applies security headers from helmet", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });

    // helmet sets this on every response; a cheap proof the perimeter is wired in.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
