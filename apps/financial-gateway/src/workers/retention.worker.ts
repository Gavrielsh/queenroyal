import { getEnv } from "../config/env";
import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";

/**
 * Data-retention sweeper for the `EngineRequestLog` outbox (Day-2 ops).
 *
 * The outbox grows without bound: every BET/WIN/DEPOSIT/ROLLBACK intent leaves a row behind.
 * Rows that are terminally SUCCEEDED have served their purpose (idempotent replay + audit of
 * in-flight work) once they age out, so this worker hard-deletes them after
 * `RETENTION_MAX_AGE_DAYS` (default 30), measured against `updatedAt`. Nothing else is ever
 * touched: PENDING/FAILED rows are live reconciler work, and ABANDONED rows are the DLQ an
 * operator inspects/replays via the admin API — both are kept indefinitely.
 *
 * Unlike the reconciler (a standalone, event-driven process), this is a LIGHTWEIGHT in-process
 * interval owned by the API server: `startRetentionWorker()` on boot, `stopRetentionWorker()`
 * during the graceful drain — BEFORE the Prisma pool disconnects, so a sweep is never killed
 * mid-query. The interval is `unref()`ed so it can never hold the event loop open, sweeps
 * never overlap (a slow delete simply skips the next tick), and a failed sweep logs and waits
 * for the next tick rather than crashing the gateway — retention is best-effort housekeeping,
 * never availability-critical.
 */

const retentionLog = childLogger({ component: "retention-worker" });

let timer: NodeJS.Timeout | null = null;
/** The currently-running sweep (if any) — awaited by stop, and the overlap guard. */
let inFlight: Promise<number> | null = null;

/**
 * Delete SUCCEEDED outbox rows older than the retention window. Returns the number of rows
 * deleted. Exported for tests and for one-off manual runs.
 */
export async function sweepExpiredOutboxRows(now: Date = new Date()): Promise<number> {
  const env = getEnv();
  const cutoff = new Date(now.getTime() - env.RETENTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  const { count } = await getPrisma().engineRequestLog.deleteMany({
    where: { status: "SUCCEEDED", updatedAt: { lt: cutoff } },
  });

  retentionLog.info(
    { deleted: count, cutoff: cutoff.toISOString(), maxAgeDays: env.RETENTION_MAX_AGE_DAYS },
    "retention sweep complete",
  );
  return count;
}

/** Run one guarded sweep: never two at once, never a crash — failures log and wait for the next tick. */
function runGuardedSweep(): Promise<number> {
  if (inFlight) return inFlight; // previous sweep still running; do not pile up deletes.

  inFlight = sweepExpiredOutboxRows()
    .catch((err: unknown) => {
      retentionLog.error({ err }, "retention sweep failed; will retry on the next interval");
      return 0;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Start the periodic sweeper: one sweep immediately on boot (so a long-down pod catches up
 * without waiting a full day), then every `RETENTION_SWEEP_INTERVAL_MS`. Idempotent — a second
 * call while running is a no-op.
 */
export function startRetentionWorker(): void {
  if (timer) return;
  const intervalMs = getEnv().RETENTION_SWEEP_INTERVAL_MS;

  retentionLog.info({ intervalMs }, "retention worker started");
  void runGuardedSweep();

  timer = setInterval(() => void runGuardedSweep(), intervalMs);
  // Never let housekeeping hold the event loop open if everything else has shut down.
  timer.unref();
}

/**
 * Stop scheduling new sweeps and WAIT for any in-flight sweep to finish, so the graceful
 * shutdown sequence can safely disconnect Prisma afterwards. Idempotent.
 */
export async function stopRetentionWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
    retentionLog.info("retention worker stopped");
  }
  if (inFlight) await inFlight;
}
