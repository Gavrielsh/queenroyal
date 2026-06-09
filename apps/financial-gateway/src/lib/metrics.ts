import type { FastifyInstance } from "fastify";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Prometheus metrics for the gateway (prom-client).
 *
 * Exposes an UNAUTHENTICATED `GET /metrics` (scraped by an in-cluster Prometheus — it MUST be
 * kept on an internal-only network boundary, never publicly routable). For EVERY request it
 * automatically tracks:
 *   - http_request_duration_seconds  — latency histogram        (method, route, status_code)
 *   - http_requests_total            — request counter          (method, route, status_code)
 *   - http_responses_5xx_total       — server-error counter     (method, route)
 *   - http_active_connections        — in-flight request gauge
 * plus prom-client's default process / Node.js metrics (CPU, memory, event-loop lag, handles).
 *
 * The registry + metric instances are MODULE-LEVEL (created once per process), so building the
 * app more than once (e.g. across tests) never re-registers a metric and throws.
 */

export const registry = new Registry();
registry.setDefaultLabels({ service: "financial-gateway" });

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds, by method/route/status.",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [registry],
});

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests, by method/route/status.",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

const http5xxTotal = new Counter({
  name: "http_responses_5xx_total",
  help: "Total HTTP 5xx server-error responses, by method/route.",
  labelNames: ["method", "route"] as const,
  registers: [registry],
});

const httpActiveConnections = new Gauge({
  name: "http_active_connections",
  help: "In-flight HTTP requests currently being processed.",
  registers: [registry],
});

let defaultsCollected = false;

/**
 * Wire metrics onto the ROOT Fastify instance (NOT via app.register — the hooks must be
 * un-encapsulated so they apply to every route). Call BEFORE the route plugins (and before the
 * rate limiter, so the active-connections gauge increments before any 429 short-circuit, keeping
 * inc/dec balanced).
 */
export function registerMetrics(app: FastifyInstance): void {
  // collectDefaultMetrics registers process/Node gauges ONCE; guard so repeated app builds (tests)
  // don't attempt to re-register them on the shared registry.
  if (!defaultsCollected) {
    collectDefaultMetrics({ register: registry });
    defaultsCollected = true;
  }

  app.addHook("onRequest", async () => {
    httpActiveConnections.inc();
  });

  app.addHook("onResponse", async (request, reply) => {
    httpActiveConnections.dec();
    // Use the matched ROUTE PATTERN (e.g. "/api/admin/dlq/:id/replay"), not the raw URL, to keep
    // label cardinality bounded. Unmatched requests (404) report "unknown".
    const route = request.routeOptions.url ?? "unknown";
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequestsTotal.inc(labels);
    if (reply.statusCode >= 500) {
      http5xxTotal.inc({ method: request.method, route });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
