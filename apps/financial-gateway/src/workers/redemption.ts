import { childLogger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { getRedemptionQueue, RedemptionQueueUnavailableError } from "../lib/redemption-queue";
import { runRedemptionListener } from "../services/redemption-worker.service";

/**
 * Redemption payout pipeline consumer. Run alongside the API server:
 *
 *   npm run worker:redemption       # from apps/financial-gateway
 *
 * Like the reconciler it polls nothing: it BLOCKS on the Redis Stream and reacts when a
 * redemption is approved. FAIL CLOSED — with no REDIS_URL it exits non-zero rather than
 * pretending to drive a payout pipeline against nothing.
 */

const workerLog = childLogger({ component: "redemption-worker-main" });

async function main(): Promise<void> {
  if (!getRedis()) {
    throw new RedemptionQueueUnavailableError(
      "redemption worker requires REDIS_URL (the event broker); refusing to start",
    );
  }
  const queue = getRedemptionQueue();

  const signal = { aborted: false };
  const stop = (sig: string): void => {
    workerLog.info({ signal: sig }, "stop requested; draining current cycle then exiting");
    signal.aborted = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  workerLog.info("redemption worker starting (event-driven)");
  await runRedemptionListener({ queue, signal });
  workerLog.info("redemption worker stopped cleanly");
}

main().catch((err: unknown) => {
  workerLog.fatal({ err }, "redemption worker crashed");
  process.exitCode = 1;
});
