"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, confirmMockStripeDeposit, fetchWalletBalances, initiateStorePurchase } from "@/lib/apiClient";
import { formatBalance } from "@/lib/format";
import { useWalletStore } from "@/store/useWalletStore";

/**
 * Cashier window (Zone 3) — a DUMB client by contract.
 *
 * ARCHITECTURE NOTE — why this component never touches money:
 * The catalog below is DISPLAY COPY only (preformatted strings keyed by package id). The
 * gateway's own catalog decides what each id costs and grants, and the Go ledger decides the
 * resulting balances. A purchase is: open the PaymentIntent (`POST /api/store/purchase`),
 * confirm the payment (here the dev mock-confirm route stands in for Stripe.js +
 * `payment_intent.succeeded`), then RE-FETCH `/api/wallet` and overwrite the mirror with the
 * server's strings verbatim. No optimistic crediting, no price math, no float ever.
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
  const balances = useWalletStore((s) => s.balances);
  const status = useWalletStore((s) => s.status);

  /** Package id with a purchase in flight, or null. One purchase at a time. */
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = useCallback((next: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), 4_000);
  }, []);

  /** Pull the authoritative snapshot from the gateway and overwrite the mirror. */
  const syncWallet = useCallback(async (): Promise<boolean> => {
    const { beginSync, setBalances, failSync } = useWalletStore.getState();
    beginSync();
    try {
      setBalances(await fetchWalletBalances());
      return true;
    } catch {
      failSync();
      return false;
    }
  }, []);

  const handleBuy = useCallback(
    async (pkg: DisplayPackage) => {
      if (buyingId) return;
      setBuyingId(pkg.id);
      try {
        // One key per attempt: it anchors both the PSP intent and the ledger credit, so a
        // network retry can never double-charge or double-credit.
        const intent = await initiateStorePurchase(pkg.id, crypto.randomUUID());

        // With the real PSP this step is `stripe.confirmCardPayment(intent.clientSecret)`;
        // the POC asks the gateway's mock PSP to capture + settle through the same webhook path.
        await confirmMockStripeDeposit(intent.paymentIntentId);

        // The ledger has credited the coins — its answer is the only one we display.
        const synced = await syncWallet();
        showToast(
          synced
            ? { kind: "success", message: `${pkg.name} pack purchased — balances updated from the ledger.` }
            : { kind: "error", message: "Purchase settled, but the wallet re-read failed — balances may be stale." },
        );
      } catch (error) {
        showToast({
          kind: "error",
          message:
            error instanceof ApiError && error.status === 401
              ? "Log in to make a purchase."
              : error instanceof ApiError
                ? `Purchase failed: ${error.message}`
                : "Purchase failed: could not reach the cashier.",
        });
      } finally {
        setBuyingId(null);
      }
    },
    [buyingId, showToast, syncWallet],
  );

  return (
    <div className="relative w-full max-w-md rounded-3xl border border-emerald-500/30 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black p-6 shadow-[0_0_60px_-15px_rgba(16,185,129,0.4)]">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-emerald-300 via-teal-200 to-emerald-300 bg-clip-text text-2xl font-black tracking-widest text-transparent">
          COIN&nbsp;STORE
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-zinc-500">Gold Coin packages · SC on the house</p>
      </div>

      {/* Live balances — a verbatim render of the ledger's strings, or honest placeholders. */}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <BalanceChip label="GC" value={balances ? formatBalance(balances.gc) : "—"} accent="text-amber-300" />
        <BalanceChip
          label="SC Unplayed"
          value={balances ? formatBalance(balances.scUnplayed) : "—"}
          accent="text-emerald-300"
        />
      </div>
      <p className="mb-6 text-center text-[9px] uppercase tracking-wider text-zinc-600">
        {status === "synced" && "ledger-synced"}
        {status === "syncing" && "syncing…"}
        {status === "error" && "stale — last sync failed"}
        {status === "empty" && "not synced"}
      </p>

      {/* Packages */}
      <ul className="space-y-3">
        {PACKAGES.map((pkg) => {
          const isBuying = buyingId === pkg.id;
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
                disabled={buyingId !== null}
                className="min-w-24 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 px-4 py-3 text-sm font-black tracking-wide text-zinc-950 shadow-lg shadow-emerald-500/25 transition active:scale-[0.97] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBuying ? "BUYING…" : `BUY ${pkg.price}`}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-center text-[9px] uppercase tracking-wider text-zinc-600">
        Mock checkout — payments settle server-side via the gateway
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

function BalanceChip({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-2 py-2 text-center">
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`truncate text-sm font-bold tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}
