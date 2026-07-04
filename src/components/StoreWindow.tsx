"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { BalanceChip } from "@/components/wallet/BalanceChip";
import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";
import { usePurchaseMutation } from "@/hooks/usePurchaseMutation";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import { onPeerActivity } from "@/lib/purchaseIntent";
import { logEvent } from "@/lib/telemetry";

/**
 * Cashier window (Zone 3) — a DUMB client by contract.
 *
 * ARCHITECTURE NOTE — why this component never touches money:
 * The catalog below is DISPLAY COPY only (preformatted strings keyed by package id). The
 * gateway's own catalog decides what each id costs and grants, and the Go ledger decides the
 * resulting balances. The purchase itself lives in usePurchaseMutation: retained attempt
 * token → PaymentIntent → confirm → settle → shared-cache invalidation. This component only
 * renders outcomes and enforces the click discipline (one purchase at a time, across tabs).
 *
 * Balance state lives ONLY in the shared query cache (`walletKeys.balances()`) observed via
 * useWalletQuery, which hydrates itself on mount — the same entry the game window renders,
 * so a settled purchase shows up in both, by construction.
 */

interface DisplayPackage {
  /** Must match a gateway catalog id (apps/financial-gateway/src/config/store-packages.ts). */
  id: string;
  name: string;
  /** Preformatted display strings — never computed or parsed in the browser. */
  price: string;
  gc: string;
  sc: string;
  highlight?: boolean;
}

const PACKAGES: readonly DisplayPackage[] = [
  { id: "pkg_starter_5", name: "Starter", price: "$5", gc: "5,000 GC", sc: "+5 SC bonus" },
  { id: "pkg_value_20", name: "Value", price: "$20", gc: "20,000 GC", sc: "+20 SC bonus", highlight: true },
  { id: "pkg_pro_50", name: "Pro", price: "$50", gc: "50,000 GC", sc: "+50 SC bonus" },
];

interface Toast {
  kind: "error" | "success";
  message: string;
}

export function StoreWindow() {
  const { balances, phase, errorStatus, lastSyncedAt } = useWalletQuery();
  const { purchase, isPending, pendingPackageId } = usePurchaseMutation();

  /** Package id a PEER TAB is actively purchasing, or null — locks Buy here too. */
  const [peerLockedBy, setPeerLockedBy] = useState<string | null>(null);
  /** Synchronous re-entry guard: two clicks in one tick both see isPending === false. */
  const attemptGate = useRef(false);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    return onPeerActivity((event) => {
      setPeerLockedBy((previous) => {
        if (event.state === "in_flight") return event.packageId;
        return previous === event.packageId ? null : previous;
      });
    });
  }, []);

  const showToast = useCallback((next: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), 4_000);
  }, []);

  const handleBuy = useCallback(
    async (pkg: DisplayPackage) => {
      if (attemptGate.current || isPending) {
        logEvent("purchase.attempt.blocked", { packageId: pkg.id, reason: "in_flight" });
        return;
      }
      if (peerLockedBy !== null) {
        logEvent("purchase.attempt.blocked", { packageId: pkg.id, reason: "peer_tab" });
        return;
      }

      attemptGate.current = true;
      try {
        const outcome = await purchase(pkg.id);

        if (outcome.status === "settled") {
          showToast(
            outcome.walletSynced
              ? { kind: "success", message: `${pkg.name} pack purchased — balances updated from the ledger.` }
              : { kind: "error", message: "Purchase settled, but the wallet re-read failed — balances may be stale." },
          );
          return;
        }

        const { failure } = outcome;
        switch (failure.kind) {
          case "unauthorized":
            showToast({ kind: "error", message: "Log in to make a purchase." });
            break;
          case "declined":
            showToast({ kind: "error", message: `Purchase failed: ${failure.message}` });
            break;
          case "retryable":
            showToast({
              kind: "error",
              message:
                failure.errorCode === "NETWORK_ERROR" || failure.errorCode === null
                  ? "Purchase failed: could not reach the cashier."
                  : `Purchase failed: ${failure.message}`,
            });
            break;
        }
      } finally {
        attemptGate.current = false;
      }
    },
    [isPending, peerLockedBy, purchase, showToast],
  );

  const buyLocked = isPending || peerLockedBy !== null;

  return (
    <div className="relative w-full max-w-md rounded-3xl border border-emerald-500/30 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black p-6 shadow-[0_0_60px_-15px_rgba(16,185,129,0.4)]">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-emerald-300 via-teal-200 to-emerald-300 bg-clip-text text-2xl font-black tracking-widest text-transparent">
          COIN&nbsp;STORE
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-zinc-500">Gold Coin packages · SC on the house</p>
      </div>

      {/* Live balances — verbatim ledger strings via the shared chip (skeletons while loading). */}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <BalanceChip family="gc" value={balances?.gc ?? null} stale={phase === "error"} />
        <BalanceChip family="scUnplayed" value={balances?.scUnplayed ?? null} stale={phase === "error"} />
      </div>
      <WalletStatusBanner phase={phase} errorStatus={errorStatus} lastSyncedAt={lastSyncedAt} />

      {/* Packages */}
      <ul className="space-y-3">
        {PACKAGES.map((pkg) => {
          const isBuying = pendingPackageId === pkg.id;
          return (
            <li
              key={pkg.id}
              className={`flex items-center justify-between gap-4 rounded-2xl border p-4 ${
                pkg.highlight
                  ? "border-emerald-500/50 bg-emerald-950/30"
                  : "border-zinc-800 bg-zinc-900/60"
              }`}
            >
              <div>
                <p className="flex items-center gap-2 text-sm font-bold text-zinc-100">
                  {pkg.name}
                  {pkg.highlight && (
                    <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-300">
                      Popular
                    </span>
                  )}
                </p>
                <p className="mt-1 text-sm font-semibold text-amber-300">{pkg.gc}</p>
                <p className="text-xs font-medium text-emerald-300">{pkg.sc}</p>
              </div>
              <button
                type="button"
                onClick={() => void handleBuy(pkg)}
                disabled={buyLocked}
                className="min-w-24 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 px-4 py-3 text-sm font-black tracking-wide text-zinc-950 shadow-lg shadow-emerald-500/25 transition active:scale-[0.97] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBuying ? "BUYING…" : `BUY ${pkg.price}`}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-center text-[9px] uppercase tracking-wider text-zinc-600">
        {peerLockedBy !== null
          ? "purchase in progress in another tab"
          : "Mock checkout — payments settle server-side via the gateway"}
      </p>

      {/* Toast */}
      {toast && (
        <div
          role="alert"
          className={`absolute inset-x-6 -bottom-16 rounded-xl px-4 py-3 text-center text-sm font-semibold shadow-xl ${
            toast.kind === "error"
              ? "bg-red-950/95 text-red-200 ring-1 ring-red-500/40"
              : "bg-emerald-950/95 text-emerald-200 ring-1 ring-emerald-500/40"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
