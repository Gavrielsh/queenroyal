import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";

/**
 * Task 2 — Prometheus metrics. /metrics is exposed without auth and exposes the required signals:
 * HTTP request durations, 5xx errors, active connections, plus prom-client's default process
 * metrics. We drive a little traffic first so at least one duration sample is recorded.
 */
describe("observability: GET /metrics (prom-client)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("exposes the required metrics in Prometheus text format, without auth", async () => {
    // Generate traffic so the histogram/counters have observed series.
    await app.inject({ method: "GET", url: "/api/health" });
    await app.inject({ method: "POST", url: "/api/store/purchase" }); // unauthenticated → 401

    const res = await app.inject({ method: "GET", url: "/metrics" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");

    const body = res.body;
    // Custom HTTP metrics (durations, totals, 5xx, active connections).
    expect(body).toContain("http_request_duration_seconds");
    expect(body).toContain("http_requests_total");
    expect(body).toContain("http_responses_5xx_total");
    expect(body).toContain("http_active_connections");
    // prom-client default process/Node.js metrics.
    expect(body).toMatch(/process_cpu_user_seconds_total|nodejs_eventloop/);
    // A concrete observed series, labelled by the matched route pattern (bounded cardinality).
    expect(body).toContain('route="/api/health"');
  });

  it("requires no authentication to scrape", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });
});
