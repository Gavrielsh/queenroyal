import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WalletBalancesDto } from "@/lib/apiClient";

type ReconcileModule = typeof import("@/lib/walletReconcile");

const SNAPSHOT: WalletBalancesDto = { gc: "1000.0000", scUnplayed: "12.5000", scRedeemable: "0.0000" };
const CREDITED: WalletBalancesDto = { gc: "6000.0000", scUnplayed: "17.5000", scRedeemable: "0.0000" };

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules(); // fresh module-level cell per test
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadModule(): Promise<ReconcileModule> {
  return import("@/lib/walletReconcile");
}

function eventsNamed(evt: string): Array<Record<string, unknown>> {
  return [...infoSpy.mock.calls]
    .map((call) => call[1] as Record<string, unknown> | undefined)
    .filter((record): record is Record<string, unknown> => record?.evt === evt);
}

describe("balancesDiffer — string inequality only (no-float law)", () => {
  it.each([
    ["identical snapshots", SNAPSHOT, { ...SNAPSHOT }, false],
    ["gc differs", SNAPSHOT, { ...SNAPSHOT, gc: "900.0000" }, true],
    ["scUnplayed differs", SNAPSHOT, { ...SNAPSHOT, scUnplayed: "0.0000" }, true],
    ["scRedeemable differs", SNAPSHOT, { ...SNAPSHOT, scRedeemable: "1.0000" }, true],
    // Strings compare as STRINGS: a scale change is a difference even if numerically equal.
    ["scale change (1000.0000 vs 1000.00)", SNAPSHOT, { ...SNAPSHOT, gc: "1000.00" }, true],
  ])("%s → %s", async (_label, baseline, current, expected) => {
    const mod = await loadModule();
    expect(mod.balancesDiffer(baseline, current as WalletBalancesDto)).toBe(expected);
  });

  it("no current snapshot → false (cannot converge on absence)", async () => {
    const mod = await loadModule();
    expect(mod.balancesDiffer(SNAPSHOT, undefined)).toBe(false);
    expect(mod.balancesDiffer(SNAPSHOT, null)).toBe(false);
    expect(mod.balancesDiffer(null, null)).toBe(false);
  });

  it("null baseline (armed pre-hydration) → any snapshot converges", async () => {
    const mod = await loadModule();
    expect(mod.balancesDiffer(null, SNAPSHOT)).toBe(true);
  });
});

describe("arming and the poll ladder", () => {
  const ARMED_AT = new Date("2026-07-05T12:00:00Z").getTime();

  it("idle: the interval is false and the state is idle", async () => {
    const mod = await loadModule();
    expect(mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT)).toBe(false);
    expect(mod.getReconcileState()).toEqual({ phase: "idle", trigger: null });
  });

  it("arming emits telemetry, notifies subscribers, and reports reconciling", async () => {
    const mod = await loadModule();
    const ticks: string[] = [];
    mod.subscribeReconcile(() => ticks.push(mod.getReconcileState().phase));

    mod.armReconcile(SNAPSHOT, { trigger: "purchase" });

    expect(mod.getReconcileState()).toEqual({ phase: "reconciling", trigger: "purchase" });
    expect(eventsNamed("wallet.reconcile.armed")[0]).toMatchObject({ trigger: "purchase" });
    expect(ticks).toEqual(["reconciling"]);
  });

  it("EVALUATION-IDEMPOTENT: repeated evaluations with an unchanged snapshot return the SAME delay", async () => {
    // THE regression this design exists for: React Query evaluates refetchInterval many
    // times back-to-back; the ladder must advance per LANDED POLL, never per evaluation.
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "spin" });
    const pollTs = ARMED_AT + 1; // one poll landed just after arming

    const delays = [1, 2, 3, 4, 5, 6].map(() => mod.reconcileIntervalFor(SNAPSHOT, pollTs));

    expect(delays).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  it("unchanged data walks the ladder ONE STEP PER LANDED POLL and caps at its top", async () => {
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "spin" });

    // Each call presents a strictly-newer dataUpdatedAt — i.e. a poll actually landed.
    const delays = [1, 2, 3, 4, 5, 6].map((poll) =>
      mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + poll),
    );

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it("snapshots predating the arm never advance the ladder", async () => {
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "spin" });

    // The mount-time snapshot (older than the arm) is re-presented repeatedly.
    const delays = [1, 2, 3].map(() => mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT - 5_000));

    expect(delays).toEqual([1_000, 1_000, 1_000]);
  });

  it("re-arming resets the baseline, budget, and ladder (latest event wins)", async () => {
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "spin" });
    mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 1); // poll 1
    mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 2); // poll 2 → ladder at 2000

    mod.armReconcile(CREDITED, { trigger: "purchase" }); // a NEW event supersedes

    expect(mod.reconcileIntervalFor(CREDITED, ARMED_AT + 3)).toBe(1_000); // ladder restarted
    expect(mod.getReconcileState().trigger).toBe("purchase");
  });
});

describe("convergence, exhaustion, disarm", () => {
  const ARMED_AT = new Date("2026-07-05T12:00:00Z").getTime();

  it("a differing snapshot converges: stands down, emits elapsed/attempts, notifies", async () => {
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "purchase" });
    mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 1_000); // one poll landed
    vi.setSystemTime(new Date("2026-07-05T12:00:03Z"));

    const result = mod.reconcileIntervalFor(CREDITED, ARMED_AT + 3_000);

    expect(result).toBe(false);
    expect(mod.getReconcileState()).toEqual({ phase: "idle", trigger: null });
    expect(eventsNamed("wallet.reconcile.converged")[0]).toMatchObject({
      trigger: "purchase",
      elapsedMs: 3_000,
      attempts: 1,
    });
  });

  it("a null-baseline arm converges on the FIRST authoritative snapshot", async () => {
    const mod = await loadModule();
    mod.armReconcile(null, { trigger: "purchase" });

    expect(mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 1)).toBe(false);
    expect(mod.getReconcileState().phase).toBe("idle");
  });

  it("the deadline exhausts: phase becomes exhausted (NOT idle), trigger retained for the UI", async () => {
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "purchase", budgetMs: 10_000 });
    mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 1_000);
    vi.setSystemTime(new Date("2026-07-05T12:00:10Z")); // exactly at the deadline

    const result = mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 10_000);

    expect(result).toBe(false);
    expect(mod.getReconcileState()).toEqual({ phase: "exhausted", trigger: "purchase" });
    expect(eventsNamed("wallet.reconcile.exhausted")[0]).toMatchObject({
      trigger: "purchase",
      budgetMs: 10_000,
    });
  });

  it("exhausted → re-arm returns to reconciling (the M4-T3 'check again' path, never a charge)", async () => {
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "purchase", budgetMs: 1_000 });
    vi.setSystemTime(new Date("2026-07-05T12:00:01Z"));
    mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 1_000); // exhausts

    mod.armReconcile(SNAPSHOT, { trigger: "purchase" });

    expect(mod.getReconcileState().phase).toBe("reconciling");
  });

  it("disarm stands down silently from any state", async () => {
    const mod = await loadModule();
    mod.armReconcile(SNAPSHOT, { trigger: "spin" });

    mod.disarmReconcile();

    expect(mod.getReconcileState()).toEqual({ phase: "idle", trigger: null });
    expect(mod.reconcileIntervalFor(SNAPSHOT, ARMED_AT + 1)).toBe(false);
    expect(eventsNamed("wallet.reconcile.converged")).toHaveLength(0);
    expect(eventsNamed("wallet.reconcile.exhausted")).toHaveLength(0);
  });

  it("unsubscribe stops notifications; a throwing subscriber never breaks its siblings", async () => {
    const mod = await loadModule();
    const seen: string[] = [];
    const unsubscribeThrowing = mod.subscribeReconcile(() => {
      throw new Error("consumer bug");
    });
    mod.subscribeReconcile(() => seen.push(mod.getReconcileState().phase));

    expect(() => mod.armReconcile(SNAPSHOT, { trigger: "spin" })).not.toThrow();
    expect(seen).toEqual(["reconciling"]);

    unsubscribeThrowing();
    mod.disarmReconcile();
    expect(seen).toEqual(["reconciling", "idle"]);
  });
});
