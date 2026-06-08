import { reconcileEngineRequests, type ReconcileSummary } from "@/services/reconciliation.service";

/**
 * Background reconciliation worker. Runs the saga compensation / replay loop on an
 * interval. Run as a long-lived process:
 *
 *   npm run worker:reconcile
 *
 * (In a serverless deployment, call `reconcileEngineRequests()` from a scheduled
 * function / cron instead of running this loop.)
 */

const INTERVAL_MS = Number(process.env.RECONCILER_INTERVAL_MS ?? "15000");

let running = true;

async function tick(): Promise<void> {
  try {
    const summary: ReconcileSummary = await reconcileEngineRequests();
    if (summary.scanned > 0) {
      console.log(`[reconciler] ${JSON.stringify(summary)}`);
    }
  } catch (err) {
    console.error("[reconciler] tick error", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  console.log(`[reconciler] starting; interval=${INTERVAL_MS}ms`);
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  console.log("[reconciler] stopped");
}

void main();
