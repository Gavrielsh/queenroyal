import { afterEach, describe, expect, it, vi } from "vitest";

import { logEvent } from "@/lib/telemetry";

describe("logEvent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits a structured record with evt + numeric ts and the caller's fields (info level)", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    logEvent("wallet.invalidated", { trigger: "spin" });

    expect(info).toHaveBeenCalledTimes(1);
    const record = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(record).toMatchObject({ evt: "wallet.invalidated", trigger: "spin" });
    expect(typeof record.ts).toBe("number");
  });

  it("routes fault/block events to console.warn so they survive a production build", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    logEvent("wallet.query.error", { code: "MALFORMED_WALLET" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it("never lets reserved keys be overwritten by caller fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    // A caller field literally named `evt`/`ts` must not clobber the authoritative values.
    logEvent("wallet.invalidated", { evt: "spoofed", ts: 0 });

    const record = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(record.evt).toBe("wallet.invalidated");
    expect(record.ts).not.toBe(0);
  });

  it("suppresses diagnostic events in production but still emits faults", () => {
    vi.stubEnv("NODE_ENV", "production");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    logEvent("wallet.invalidated", { trigger: "spin" }); // diagnostic → suppressed
    logEvent("wallet.query.error", { code: "X" }); // fault → still emitted

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never throws even if the underlying console sink throws", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("sink exploded");
    });

    expect(() => logEvent("wallet.invalidated", { trigger: "spin" })).not.toThrow();
  });
});
