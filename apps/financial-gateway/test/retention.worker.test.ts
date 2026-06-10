import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace the Prisma singleton with the in-memory fake (shared instance with the helpers).
vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { resetEnvCacheForTests } from "../src/config/env";
import {
  startRetentionWorker,
  stopRetentionWorker,
  sweepExpiredOutboxRows,
} from "../src/workers/retention.worker";
import { getJournal, resetDb, seedJournalRow } from "./fakes/prisma.fake";

/** Days → ms. */
const days = (n: number): number => n * 24 * 60 * 60 * 1000;

/** Seed an outbox row whose `updatedAt` is `ageDays` in the past. */
function seedAged(opTx: string, status: string, ageDays: number): void {
  const stamp = new Date(Date.now() - days(ageDays));
  seedJournalRow({
    operatorTransactionId: opTx,
    type: "BET",
    status,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

describe("retention worker — outbox sweeper", () => {
  beforeEach(() => {
    resetDb();
    resetEnvCacheForTests();
  });
  afterEach(async () => {
    await stopRetentionWorker();
    resetEnvCacheForTests();
  });

  it("deletes ONLY SUCCEEDED rows older than 30 days; everything else survives", async () => {
    seedAged("succeeded-old", "SUCCEEDED", 31); // eligible
    seedAged("succeeded-fresh", "SUCCEEDED", 29); // too young
    seedAged("abandoned-old", "ABANDONED", 90); // DLQ — kept for operators
    seedAged("failed-old", "FAILED", 90); // live reconciler work — kept
    seedAged("pending-old", "PENDING", 90); // live reconciler work — kept

    const deleted = await sweepExpiredOutboxRows();

    expect(deleted).toBe(1);
    expect(getJournal("succeeded-old")).toBeUndefined();
    expect(getJournal("succeeded-fresh")).toBeDefined();
    expect(getJournal("abandoned-old")).toBeDefined();
    expect(getJournal("failed-old")).toBeDefined();
    expect(getJournal("pending-old")).toBeDefined();
  });

  it("honours an env-overridden RETENTION_MAX_AGE_DAYS window", async () => {
    process.env.RETENTION_MAX_AGE_DAYS = "7";
    resetEnvCacheForTests();
    seedAged("succeeded-8d", "SUCCEEDED", 8);
    seedAged("succeeded-6d", "SUCCEEDED", 6);

    const deleted = await sweepExpiredOutboxRows();

    expect(deleted).toBe(1);
    expect(getJournal("succeeded-8d")).toBeUndefined();
    expect(getJournal("succeeded-6d")).toBeDefined();
    delete process.env.RETENTION_MAX_AGE_DAYS;
  });

  it("is a no-op (count 0) on an empty / fully-fresh outbox", async () => {
    seedAged("succeeded-fresh", "SUCCEEDED", 1);
    expect(await sweepExpiredOutboxRows()).toBe(0);
    expect(getJournal("succeeded-fresh")).toBeDefined();
  });

  it("start → sweeps immediately on boot; stop is idempotent and awaits completion", async () => {
    seedAged("succeeded-old", "SUCCEEDED", 45);

    startRetentionWorker();
    startRetentionWorker(); // idempotent — must not double-schedule

    // The boot sweep is fire-and-forget; stop() awaits any in-flight sweep before returning,
    // which is exactly the graceful-shutdown guarantee server.ts relies on.
    await stopRetentionWorker();
    await stopRetentionWorker(); // idempotent

    expect(getJournal("succeeded-old")).toBeUndefined();
  });

  it("sweeps again on each interval tick", async () => {
    vi.useFakeTimers();
    try {
      startRetentionWorker(); // boot sweep on an empty journal
      await vi.runOnlyPendingTimersAsync();

      seedAged("succeeded-old", "SUCCEEDED", 31);
      await vi.advanceTimersByTimeAsync(days(1)); // default RETENTION_SWEEP_INTERVAL_MS = 24h

      expect(getJournal("succeeded-old")).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await stopRetentionWorker();
    }
  });
});
