import { buildApp } from "./app";
import { getEnv } from "./config/env";
import { disconnectPrisma } from "./lib/prisma";
import { disconnectRedis } from "./lib/redis";

/**
 * Process entrypoint for the standalone financial gateway.
 *
 * Builds the Fastify app, starts listening, and wires PRODUCTION-GRADE graceful shutdown: on
 * SIGTERM/SIGINT we drain in-flight requests and release every downstream resource in a strict
 * order, backed by an ABSOLUTE kill-switch so a hung drain can never wedge a pod (the
 * orchestrator restarts a process that exits non-zero). Truly-unexpected faults crash loudly
 * instead of limping on in an unknown state; liveness (`/api/health`) stays dependency-free so a
 * healthy process is never killed for a downstream blip.
 */

/**
 * Absolute upper bound on a graceful drain. If app/Redis/Prisma teardown has not finished by
 * now, we STOP WAITING and force-exit non-zero. Keep this comfortably under the orchestrator's
 * own termination grace period (e.g. Kubernetes `terminationGracePeriodSeconds`) so WE decide
 * how the process dies rather than eating a SIGKILL.
 */
const HARD_SHUTDOWN_MS = 15_000;

async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return; // idempotent: a second signal must not race the first drain.
    shuttingDown = true;
    app.log.info({ signal }, "shutdown signal received; draining connections");

    // Arm the kill-switch FIRST so it covers the entire teardown. `unref()` keeps the timer
    // from holding the event loop open once the drain finishes (we also exit explicitly below).
    const killTimer = setTimeout(() => {
      app.log.fatal({ timeoutMs: HARD_SHUTDOWN_MS }, "graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, HARD_SHUTDOWN_MS);
    killTimer.unref();

    try {
      // Strict, sequential teardown order:
      //   1. app.close()          — stop accepting new sockets; let in-flight requests finish.
      //   2. redis.quit()         — release replay / rate-limit / breaker state (drains replies).
      //   3. prisma.$disconnect() — close the Postgres/PgBouncer pool LAST, once nothing needs it.
      await app.close();
      await disconnectRedis();
      await disconnectPrisma();

      clearTimeout(killTimer);
      app.log.info("graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      clearTimeout(killTimer);
      app.log.error({ err }, "error during graceful shutdown");
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
