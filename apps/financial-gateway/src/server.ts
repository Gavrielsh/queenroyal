import { buildApp } from "./app";
import { getEnv } from "./config/env";
import { disconnectPrisma } from "./lib/prisma";
import { disconnectRedis } from "./lib/redis";
import { startRetentionWorker, stopRetentionWorker } from "./workers/retention.worker";

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

async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();

  // Absolute upper bound on a graceful drain — ENV-DRIVEN (SHUTDOWN_TIMEOUT_MS, default 15s),
  // not hardcoded, so an orchestrator can align it with its own pod eviction grace period (e.g.
  // Kubernetes terminationGracePeriodSeconds). If app/Redis/Prisma teardown has not finished by
  // then we STOP WAITING and force-exit non-zero so WE decide how the process dies, not SIGKILL.
  const shutdownTimeoutMs = env.SHUTDOWN_TIMEOUT_MS;

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return; // idempotent: a second signal must not race the first drain.
    shuttingDown = true;
    app.log.info({ signal }, "shutdown signal received; draining connections");

    // Arm the kill-switch FIRST so it covers the entire teardown. `unref()` keeps the timer
    // from holding the event loop open once the drain finishes (we also exit explicitly below).
    const killTimer = setTimeout(() => {
      app.log.fatal({ timeoutMs: shutdownTimeoutMs }, "graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, shutdownTimeoutMs);
    killTimer.unref();

    try {
      // Strict, sequential teardown order:
      //   1. app.close()             — stop accepting new sockets; let in-flight requests finish.
      //   2. stopRetentionWorker()   — stop the outbox sweeper and wait out any in-flight sweep,
      //                                so the Prisma pool below never closes under a live query.
      //   3. redis.quit()            — release replay / rate-limit / breaker state (drains replies).
      //   4. prisma.$disconnect()    — close the Postgres/PgBouncer pool LAST, once nothing needs it.
      await app.close();
      await stopRetentionWorker();
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

  // Day-2 housekeeping: sweep aged-out SUCCEEDED outbox rows. Started only once the server is
  // actually serving (a boot that fails to listen never opens a DB pool just to clean up).
  startRetentionWorker();
}

void main();
