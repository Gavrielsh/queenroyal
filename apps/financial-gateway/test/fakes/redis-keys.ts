import type { StreamKeys } from "../../src/lib/reconcile-queue";

/**
 * A private Redis keyspace for one test file.
 *
 * Vitest runs test FILES in parallel threads. Three suites exercising the
 * redemption queue against the SAME `redemption:events` and `reconcile:dlq` keys
 * therefore delete and consume each other's messages — which showed up as two or
 * three failures per run that never reproduced when a file was run alone. A
 * flaky money-pipeline test is worse than no test: it trains everyone to re-run
 * the build instead of reading it.
 *
 * Isolating by KEY rather than by forcing the files to run sequentially keeps the
 * parallelism and removes the shared state, which is the actual defect.
 */
export function testStreamKeys(suite: string): StreamKeys {
  return {
    stream: `test:${suite}:events`,
    group: `test-${suite}-workers`,
    schedule: `test:${suite}:scheduled`,
    dlq: `test:${suite}:dlq`,
  };
}
