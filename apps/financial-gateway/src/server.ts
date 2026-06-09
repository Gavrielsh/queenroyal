import { buildApp } from "./app";
import { getEnv } from "./config/env";

/**
 * Process entrypoint for the standalone financial gateway.
 *
 * Builds the Fastify app, starts listening, and wires graceful shutdown so in-flight requests
 * drain on SIGINT/SIGTERM (clean rolling deploys, no dropped connections). Truly-unexpected
 * faults crash the process loudly instead of letting it limp on in an unknown state — the
 * orchestrator restarts it; liveness (`/api/health`) stays dependency-free so a healthy
 * process is never killed for a downstream blip.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutdown signal received; draining connections");
    try {
      await app.close();
      app.log.info("server closed cleanly");
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ err: reason }, "unhandledRejection; exiting");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "uncaughtException; exiting");
    process.exit(1);
  });

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.fatal({ err }, "failed to start listening");
    process.exit(1);
  }
}

void main();
