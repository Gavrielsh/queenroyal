"use client";

import { useEffect, useState } from "react";

import type { WalletPhase } from "@/hooks/useWalletQuery";

/**
 * The wallet's sync-state readout — one honest line under the chips.
 *
 * Non-error phases render as a quiet status line ("ledger-synced · 12s ago", "syncing…",
 * "not synced"); error phases render as a PERSISTENT banner with the exact copy the suite
 * asserts ("log in to see your wallet" / "stale — last sync failed").
 *
 * Deliberately `role="status"` (polite), NEVER `role="alert"`: action toasts own the alert
 * channel, and Next.js already injects a route-announcer alert — a third assertive region
 * would double-announce every failure to screen readers (and break the suite's single-alert
 * queries).
 *
 * The relative age is integer math on TIMESTAMPS (allowed — timestamps are not money).
 */
export interface WalletStatusBannerProps {
  phase: WalletPhase;
  errorStatus: number | null;
  lastSyncedAt: number | null;
}

function relativeAge(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function WalletStatusBanner({ phase, errorStatus, lastSyncedAt }: WalletStatusBannerProps) {
  const [now, setNow] = useState(() => Date.now());

  // Coarse 5s tick, only while synced — enough for "Xs ago" without re-render storms.
  useEffect(() => {
    if (phase !== "synced" || lastSyncedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [phase, lastSyncedAt]);

  // A fresh sync restarts the age from its own timestamp immediately.
  useEffect(() => {
    setNow(Date.now());
  }, [lastSyncedAt]);

  if (phase === "error") {
    const unauthorized = errorStatus === 401;
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="wallet-status-banner"
        className={`mb-6 flex items-center justify-center gap-2 rounded-chip border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider ${
          unauthorized
            ? "border-warning/40 bg-warning/10 text-warning"
            : "border-stale/40 bg-stale/10 text-stale"
        }`}
      >
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        <span>{unauthorized ? "log in to see your wallet" : "stale — last sync failed"}</span>
      </div>
    );
  }

  return (
    <p
      data-testid="wallet-status-line"
      className="mb-6 text-center text-[9px] uppercase tracking-wider text-ink-faint"
    >
      {phase === "synced" && (
        <>
          <span className="text-sc-unplayed/90">ledger-synced</span>
          {lastSyncedAt !== null && <span data-testid="synced-ago"> · {relativeAge(lastSyncedAt, now)}</span>}
        </>
      )}
      {phase === "syncing" && "syncing…"}
      {phase === "empty" && "not synced"}
    </p>
  );
}
