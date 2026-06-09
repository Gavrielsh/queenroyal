import { childLogger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { getReconcileQueue, ReconcileQueueUnavailableError } from "../lib/reconcile-queue";
import { runReconcileListener } from "../services/reconciliation.service";

/**
 * Event-driven reconciliation consumer — now OWNED by the gateway workspace. Run as a
 * long-lived process alongside the API server:
 *
 *   npm run worker:reconcile        # from apps/financial-gateway
 *
 * It does NOT poll Postgres and runs no interval/cron. It BLOCKS on the Redis Stream
 * (`XREADGROUP … BLOCK`) and reacts the instant a producer (spin adapter, PSP webhook,
 * cashier) emits a reconcile event, reclaiming any in-flight work a crashed peer left behind
 * and parking terminal failures in the Dead Letter Queue.
 *
 * FAIL CLOSED: the broker requires Redis. With no `REDIS_URL` the consumer cannot run, so it
 * exits non-zero rather than pretending to reconcile against nothing.
 */

const workerLog = childLogger({ component: "reconciler-worker" });

async function main(): Promise<void> {
  if (!getRedis()) {
    throw new ReconcileQueueUnavailableError(
      "reconciler worker requires REDIS_URL (the event broker); refusing to start",
    );
  }

  // Surface a clear failure now if the broker can't be constructed.
  const queue = getReconcileQueue();

  const signal = { aborted: false };
  const stop = (sig: string): void => {
    workerLog.info({ signal: sig }, "stop requested; draining current cycle then exiting");
    signal.aborted = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  workerLog.info("reconciler worker starting (event-driven)");
  await runReconcileListener({ queue, signal });
  workerLog.info("reconciler worker stopped cleanly");
}

main().catch((err: unknown) => {
  workerLog.fatal({ err }, "reconciler worker crashed");
  process.exitCode = 1;
});
