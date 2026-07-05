import type { WalletBalancesDto } from "@/lib/apiClient";
import { logEvent } from "@/lib/telemetry";

/**
 * Bounded "refetch-until-changed" reconcile controller (M4 Phase A).
 *
 * WHY: the ledger credit after a money event is EVENTUALLY consistent (webhook-driven), so a
 * single post-action read can cache a pre-credit balance as if it were final. This module
 * holds a baseline snapshot and a time budget; while armed, the wallet query polls (with
 * backoff) until the authoritative snapshot DIFFERS from the baseline — then stands down.
 *
 * TRUE MODULARITY: this is a pure state/deadline module. It performs NO fetching and holds
 * NO query-client reference — React Query does every network read. The integration surface
 * is exactly one function (`reconcileIntervalFor`), consumed by useWalletQuery's
 * `refetchInterval`, which React Query re-evaluates each time a fetch settles.
 *
 * CONTRACT (kick-off): arming does not itself start a fetch. The caller (M4-T2: the settle
 * paths) follows `armReconcile` with the ordinary choke-point invalidation — that read is
 * poll #1, and the interval ladder chains from its settlement.
 *
 * NO-FLOAT LAW: convergence is detected by `balancesDiffer` — pure string inequality on the
 * engine's decimal strings. Money is never parsed, here or anywhere.
 *
 * `exhausted` is NOT an error: the credit may still land later (focus/mount refetches remain
 * the durable backstop). It is a distinct honest state the UI renders calmly (M4-T3).
 */

export type ReconcileTrigger = "purchase" | "spin";

export type ReconcilePhase = "idle" | "reconciling" | "exhausted";

export interface ReconcileState {
  phase: ReconcilePhase;
  /** The money event being reconciled (or the one that exhausted); null when idle. */
  trigger: ReconcileTrigger | null;
}

export interface ArmOptions {
  trigger: ReconcileTrigger;
  /** Total time budget before standing down as `exhausted`. */
  budgetMs?: number;
}

/** Poll ladder: patient enough to be gentle on the gateway, fast enough to feel live. */
const BACKOFF_LADDER_MS = [1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_BUDGET_MS = 45_000;

interface ReconcileCell {
  baseline: WalletBalancesDto | null;
  trigger: ReconcileTrigger;
  budgetMs: number;
  deadline: number;
  armedAt: number;
  attempts: number;
}

let cell: ReconcileCell | null = null;
let phase: ReconcilePhase = "idle";
let lastTrigger: ReconcileTrigger | null = null;

const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    try {
      subscriber();
    } catch {
      // A consumer fault must never break reconciliation for other listeners.
    }
  }
}

/**
 * True when the current authoritative snapshot is NEW INFORMATION relative to the baseline.
 * Pure string comparison, field by field — the no-float law applies to reconciliation too.
 *  - no current snapshot → nothing to compare → false (cannot converge on absence)
 *  - null baseline (armed before hydration) → any snapshot converges
 */
export function balancesDiffer(
  baseline: WalletBalancesDto | null,
  current: WalletBalancesDto | null | undefined,
): boolean {
  if (current === null || current === undefined) return false;
  if (baseline === null) return true;
  return (
    baseline.gc !== current.gc ||
    baseline.scUnplayed !== current.scUnplayed ||
    baseline.scRedeemable !== current.scRedeemable
  );
}

/**
 * Arm (or re-arm) reconciliation around a money event. Re-arming replaces the baseline,
 * budget, and attempt count — the LATEST event is the one being converged on.
 */
export function armReconcile(baseline: WalletBalancesDto | null, opts: ArmOptions): void {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = Date.now();
  cell = {
    baseline,
    trigger: opts.trigger,
    budgetMs,
    deadline: now + budgetMs,
    armedAt: now,
    attempts: 0,
  };
  phase = "reconciling";
  lastTrigger = opts.trigger;
  logEvent("wallet.reconcile.armed", { trigger: opts.trigger, budgetMs });
  notifySubscribers();
}

/** Stand down silently (logout/unmount/manual). Clears any exhausted flag too. */
export function disarmReconcile(): void {
  if (cell === null && phase === "idle") return;
  cell = null;
  phase = "idle";
  lastTrigger = null;
  notifySubscribers();
}

export function getReconcileState(): ReconcileState {
  return { phase, trigger: lastTrigger };
}

/** Subscribe to phase transitions (armed/converged/exhausted/disarmed). Returns unsubscribe. */
export function subscribeReconcile(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/**
 * THE React Query integration point — pass the query's current data each time RQ evaluates
 * `refetchInterval`. Returns the next poll delay while reconciling, or `false` to stand
 * down (idle, converged, or exhausted). Disarmed behavior is EXACTLY `false`, i.e. the
 * query behaves as if no refetchInterval were configured.
 */
export function reconcileIntervalFor(current: WalletBalancesDto | undefined): number | false {
  if (cell === null) return false;

  if (balancesDiffer(cell.baseline, current)) {
    logEvent("wallet.reconcile.converged", {
      trigger: cell.trigger,
      elapsedMs: Date.now() - cell.armedAt,
      attempts: cell.attempts,
    });
    cell = null;
    phase = "idle";
    lastTrigger = null;
    notifySubscribers();
    return false;
  }

  if (Date.now() >= cell.deadline) {
    logEvent("wallet.reconcile.exhausted", {
      trigger: cell.trigger,
      budgetMs: cell.budgetMs,
      attempts: cell.attempts,
    });
    phase = "exhausted"; // lastTrigger kept — the UI names what is still pending
    cell = null;
    notifySubscribers();
    return false;
  }

  const step = Math.min(cell.attempts, BACKOFF_LADDER_MS.length - 1);
  cell.attempts += 1;
  return BACKOFF_LADDER_MS[step] ?? BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1] ?? 8_000;
}
