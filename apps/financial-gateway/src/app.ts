import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { getEnv } from "./config/env";
import { buildLoggerOptions } from "./lib/logger";
import { registerMetrics } from "./lib/metrics";
import { getRedis } from "./lib/redis";
import { errBody } from "./lib/reply";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { storeRoutes } from "./routes/store";
import { webhookRoutes } from "./routes/webhooks";

/**
 * Build a fully-configured (but not-yet-listening) Fastify instance.
 *
 * Kept separate from the process bootstrap in `server.ts` so tests can drive it through
 * `app.inject()` with no open socket, and so the security perimeter is assembled in exactly
 * one place. The order matters: helmet (secure headers) and CORS register BEFORE routes, so
 * every response — including 404s and errors — carries the perimeter's headers.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    logger: buildLoggerOptions(),
    // Honour the edge/load-balancer's X-Forwarded-* so the real client IP and protocol are
    // available (needed for the fail-closed rate limiting that lands in a later phase).
    trustProxy: true,
    // Reject oversized bodies outright (defence in depth; legitimate webhooks are tiny).
    bodyLimit: env.BODY_LIMIT_BYTES,
    // Correlate logs with an inbound trace id when the caller supplies one.
    requestIdHeader: "x-request-id",
  });

  // ── Security perimeter ─────────────────────────────────────────────────────────
  // Secure headers on every response.
  await app.register(helmet, { global: true });

  // Strict CORS allow-list. An empty list disables cross-origin browser access entirely,
  // which is the correct default for a server-to-server / webhook gateway.
  await app.register(cors, {
    origin: env.CORS_ALLOWED_ORIGINS.length > 0 ? [...env.CORS_ALLOWED_ORIGINS] : false,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  // Parse/serialize cookies so the auth routes can read the HttpOnly refresh-token cookie and
  // set/clear it. No global signing secret: the refresh token is itself a high-entropy opaque
  // secret validated against Redis, so a separate cookie signature buys nothing.
  await app.register(cookie);

  // ── Observability: Prometheus metrics ────────────────────────────────────────────
  // Root-level hooks (global, un-encapsulated) + an unauthenticated GET /metrics. Registered
  // BEFORE the rate limiter so the active-connections gauge increments before any 429
  // short-circuit, and so /metrics scraping is never rate-limited.
  registerMetrics(app);

  // ── Global rate limiting (coarse per-IP DoS guard) ───────────────────────────────
  // Distributed across pods via the validated Redis client when present (in-memory single-process
  // fallback otherwise). This is a SECOND, broad layer; the fail-closed auth limiter still guards
  // the brute-force-sensitive auth surface independently. Health probes and the metrics scrape are
  // never throttled. Over-limit → a standard 429 in the gateway's uniform envelope (the plugin
  // also sets Retry-After + RateLimit-* headers).
  const redis = getRedis();
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    ...(redis ? { redis } : {}),
    allowList: (req: FastifyRequest) =>
      req.url.startsWith("/api/health") || req.url.startsWith("/metrics"),
    // On breach the plugin THROWS this value, so return an Error carrying `statusCode` — the
    // app's setErrorHandler then renders a clean 429 in the standard envelope (a plain object
    // would fall through to 500). The Retry-After / RateLimit-* headers are already set by the
    // plugin and survive the error handler.
    errorResponseBuilder: (_req, context) =>
      Object.assign(new Error("Too many requests; please slow down"), {
        statusCode: context.statusCode,
        code: "RATE_LIMITED",
      }),
  });

  // ── Uniform JSON envelopes for not-found and errors ──────────────────────────────
  // Registered BEFORE the route plugins: a Fastify child context snapshots its parent's error
  // handler at registration time, so setting this first is what makes the gateway envelope apply
  // to errors thrown INSIDE the route plugins — and to errors thrown by global hooks such as the
  // rate limiter's 429 (otherwise Fastify's default error shape would leak through).
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(errBody("NOT_FOUND", "Route not found"));
  });

  app.setErrorHandler((err, req, reply) => {
    const { statusCode, code, message } = normalizeError(err);
    const status = statusCode >= 400 ? statusCode : 500;

    if (status >= 500) {
      // Log the full (pino-redacted) error; return an opaque body so internals never leak.
      req.log.error({ err }, "unhandled error");
      reply.code(status).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
      return;
    }

    // 4xx (including Fastify schema-validation failures) — safe to surface the message.
    reply.code(status).send(errBody(code, message));
  });

  // ── Routes ─────────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(authRoutes);
  await app.register(storeRoutes);
  await app.register(adminRoutes);

  return app;
}

/**
 * Fastify v5 hands the error handler an `unknown`. Narrow it defensively — never assume a
 * shape — into the fields we actually serialize, so a thrown non-Error can never crash the
 * handler itself.
 */
function normalizeError(err: unknown): { statusCode: number; code: string; message: string } {
  if (err !== null && typeof err === "object") {
    const e = err as { statusCode?: unknown; code?: unknown; message?: unknown };
    return {
      statusCode: typeof e.statusCode === "number" ? e.statusCode : 500,
      code: typeof e.code === "string" ? e.code : "BAD_REQUEST",
      message: typeof e.message === "string" ? e.message : "Request failed",
    };
  }
  return { statusCode: 500, code: "INTERNAL_ERROR", message: "Request failed" };
}
