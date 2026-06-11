"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, fetchWalletBalances } from "@/lib/apiClient";
import { useWalletStore } from "@/store/useWalletStore";

/**
 * Dev harness for the Zone 3 wallet mirror.
 *
 * ARCHITECTURE NOTE — why this component places no bets:
 * Real wagers NEVER originate in the browser. A spin is settled provider-side: the game
 * aggregator's server calls the gateway's HMAC-verified webhook (`POST
 * /api/webhooks/provider/spin`), the gateway debits/credits the Go ledger, and the ledger's
 * post-balances become the truth. The browser's only money operation is the read:
 * `GET /api/wallet` → mirror → render. This window demonstrates exactly that loop — spin
 * animation for feel, then a re-fetch of the authoritative balances. No optimistic
 * deduction, no local win math, no client-supplied amounts.
 */
const GAME_ID = "mock-slot-1";

interface Toast {
  kind: "error" | "success";
  message: string;
}

const REEL_SYMBOLS = ["🍒", "💎", "7️⃣", "🔔", "👑", "🍋"] as const;

/**
 * Display-format an engine decimal string ("1234.5000") with thousands separators using
 * pure string operations — money strings are never parsed into floats, even for rendering.
 */
function formatBalance(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

export function MockGameWindow() {
  const balances = useWalletStore((s) => s.balances);
  const status = useWalletStore((s) => s.status);

  const [isSpinning, setIsSpinning] = useState(false);
  const [reels, setReels] = useState<readonly [string, string, string]>(["👑", "👑", "👑"]);
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
    } catch (error) {
      failSync();
      showToast({
        kind: "error",
        message:
          error instanceof ApiError && error.status === 401
            ? "Log in to see your wallet."
            : "Could not reach the cashier — balances may be stale.",
      });
      return false;
    }
  }, [showToast]);

  // Hydrate the mirror on mount; production would refresh on a realtime channel instead.
  useEffect(() => {
    void syncWallet();
  }, [syncWallet]);

  const handleSpin = useCallback(async () => {
    if (isSpinning) return;
    setIsSpinning(true);

    // Animation only — the round itself settles provider-side against the ledger.
    const spinAnimation = setInterval(() => {
      setReels([
        REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)] ?? "👑",
        REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)] ?? "👑",
        REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)] ?? "👑",
      ]);
    }, 80);

    try {
      await new Promise((resolve) => setTimeout(resolve, 900));
      // After the (out-of-band) round settles, the ledger is the only truth: re-fetch it.
      const ok = await syncWallet();
      if (ok) showToast({ kind: "success", message: "Wallet mirror synced with the ledger." });
    } finally {
      clearInterval(spinAnimation);
      setIsSpinning(false);
    }
  }, [isSpinning, showToast, syncWallet]);

  return (
    <div className="relative w-full max-w-md rounded-3xl border border-amber-500/30 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black p-6 shadow-[0_0_60px_-15px_rgba(245,158,11,0.4)]">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-2xl font-black tracking-widest text-transparent">
          QUEEN&nbsp;ROYAL
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-zinc-500">Mock Slot · {GAME_ID}</p>
      </div>

      {/* Live balances — a verbatim render of the ledger's strings, or honest placeholders. */}
      <div className="mb-2 grid grid-cols-3 gap-2">
        <BalanceChip label="GC" value={balances ? formatBalance(balances.gc) : "—"} accent="text-amber-300" />
        <BalanceChip
          label="SC Unplayed"
          value={balances ? formatBalance(balances.scUnplayed) : "—"}
          accent="text-emerald-300"
        />
        <BalanceChip
          label="SC Redeemable"
          value={balances ? formatBalance(balances.scRedeemable) : "—"}
          accent="text-sky-300"
        />
      </div>
      <p className="mb-6 text-center text-[9px] uppercase tracking-wider text-zinc-600">
        {status === "synced" && "ledger-synced"}
        {status === "syncing" && "syncing…"}
        {status === "error" && "stale — last sync failed"}
        {status === "empty" && "not synced"}
      </p>

      {/* Reels */}
      <div className="mb-6 flex justify-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
        {reels.map((symbol, i) => (
          <div
            key={i}
            className={`flex h-20 w-20 items-center justify-center rounded-xl border border-zinc-700 bg-gradient-to-b from-zinc-800 to-zinc-900 text-4xl shadow-inner ${
              isSpinning ? "animate-pulse" : ""
            }`}
          >
            {symbol}
          </div>
        ))}
      </div>

      {/* Spin button */}
      <button
        type="button"
        onClick={() => void handleSpin()}
        disabled={isSpinning}
        className="w-full rounded-2xl bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-500 py-4 text-lg font-black tracking-widest text-zinc-950 shadow-lg shadow-amber-500/25 transition active:scale-[0.98] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSpinning ? "SPINNING…" : "SPIN (settles provider-side)"}
      </button>

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
