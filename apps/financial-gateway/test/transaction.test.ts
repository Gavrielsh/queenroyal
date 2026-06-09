import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { isRetryableTxError, isUniqueViolation, runInTransaction } from "../src/lib/db/transaction";

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`error ${code}`, { code, clientVersion: "6.0.0" });
}

/**
 * A fake PrismaClient whose `$transaction` throws `times` times (with `errorCode`) before
 * succeeding — exercising runInTransaction's retry policy with no real database.
 */
function fakeDb(times: number, errorCode: string): { db: PrismaClient; calls: () => number } {
  let calls = 0;
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      calls += 1;
      if (calls <= times) throw knownError(errorCode);
      return fn({});
    },
  } as unknown as PrismaClient;
  return { db, calls: () => calls };
}

describe("transaction helpers", () => {
  it("classifies P2002 as a unique violation", () => {
    expect(isUniqueViolation(knownError("P2002"))).toBe(true);
    expect(isUniqueViolation(knownError("P2034"))).toBe(false);
    expect(isUniqueViolation(new Error("nope"))).toBe(false);
  });

  it("classifies P2034 as a retryable serialization/deadlock error", () => {
    expect(isRetryableTxError(knownError("P2034"))).toBe(true);
    expect(isRetryableTxError(knownError("P2002"))).toBe(false);
    expect(isRetryableTxError(new Error("nope"))).toBe(false);
  });

  it("retries a serialization failure, then returns the eventual result", async () => {
    const { db, calls } = fakeDb(2, "P2034");
    const result = await runInTransaction(async () => "ok", { maxRetries: 5, timeoutMs: 10, maxWaitMs: 10 }, db);
    expect(result).toBe("ok");
    expect(calls()).toBe(3); // two failures + one success
  });

  it("does NOT retry a non-retryable error", async () => {
    const { db, calls } = fakeDb(1, "P2002");
    await expect(
      runInTransaction(async () => "ok", { maxRetries: 5 }, db),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(calls()).toBe(1);
  });

  it("rethrows once retries are exhausted", async () => {
    const { db, calls } = fakeDb(99, "P2034");
    await expect(
      runInTransaction(async () => "ok", { maxRetries: 3, timeoutMs: 5, maxWaitMs: 5 }, db),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(calls()).toBe(4); // initial attempt + 3 retries
  });
});
