import type { FastifyPluginAsync } from "fastify";

/**
 * Liveness probe. Intentionally touches NOTHING external — no Postgres, no Redis, no engine.
 * It answers exactly one question: "is this process up and able to serve requests?".
 *
 * Readiness of downstream dependencies (Redis breaker, engine reachability) belongs on a
 * SEPARATE, future `/api/ready` probe. Keeping liveness dependency-free means a Redis or
 * engine blip can never fail liveness and trigger a needless container restart loop.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/api/health",
    {
      // An explicit response schema lets Fastify use its fast JSON serializer (no reflection).
      schema: {
        response: {
          200: {
            type: "object",
            required: ["status", "service", "uptime_s", "timestamp"],
            additionalProperties: false,
            properties: {
              status: { type: "string" },
              service: { type: "string" },
              uptime_s: { type: "number" },
              timestamp: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok",
      service: "financial-gateway",
      uptime_s: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );
};
