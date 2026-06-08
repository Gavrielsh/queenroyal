import { childLogger } from "@/lib/logger";
import { reconcileEngineRequests, type ReconcileSummary } from "@/services/reconciliation.service";

/**
 * Background reconciliation worker. Runs the saga compensation / replay loop on an
 * interval. Run as a long-lived process:
 *
 *   npm run worker:reconcile
 *
 * (In a serverless deployment, call `reconcileEngineRequests()` from a scheduled
 * function / cron instead of running this loop — see /api/internal/cron/reconcile.)
 */

const INTERVAL_MS = Number(process.env.RECONCILER_INTERVAL_MS ?? "15000");
const workerLog = childLogger({ component: "reconciler-worker" });

let running = true;

async function tick(): Promise<void> {
  try {
    const summary: ReconcileSummary = await reconcileEngineRequests();
    if (summary.scanned > 0) {
      workerLog.info({ summary }, "reconcile batch processed");
    }
  } catch (err) {
    workerLog.error({ err }, "reconcile tick failed");
  }
}

async function main(): Promise<void> {
  workerLog.info({ interval_ms: INTERVAL_MS }, "reconciler worker starting");
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  workerLog.info("reconciler worker stopped");
}

void main();
