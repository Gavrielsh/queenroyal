"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { BalanceChip } from "@/components/wallet/BalanceChip";
import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";
import { useWalletQuery } from "@/hooks/useWalletQuery";

/**
 * Dev harness for the Zone 3 wallet mirror.
 *
 * ARCHITECTURE NOTE — why this component places no bets:
 * Real wagers NEVER originate in the browser. A spin is settled provider-side: the game
 * aggregator's server calls the gateway's HMAC-verified webhook (`POST
 * /api/webhooks/provider/spin`), the gateway debits/credits the Go ledger, and the ledger's
 * post-balances become the truth. The browser's only money operation is the read:
 * `GET /api/wallet` → shared React Query cache → render. This window demonstrates exactly
 * that loop — spin animation for feel, then a re-read of the authoritative balances. No
 * optimistic deduction, no local win math, no client-supplied amounts.
 *
 * The wallet "mirror" IS the shared React Query cache entry (`walletKeys.balances()`),
 * observed through useWalletQuery, which hydrates itself on mount. This component holds no
 * balance state of its own.
 */
const GAME_ID = "mock-slot-1";

interface Toast {
  kind: "error" | "success";
  message: string;
}

const REEL_SYMBOLS = ["🍒", "💎", "7️⃣", "🔔", "👑", "🍋"] as const;

export function MockGameWindow() {
  const { balances, phase, errorStatus, lastSyncedAt, invalidate } = useWalletQuery();

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
      // After the (out-of-band) round settles, the ledger may have changed: invalidate the
      // shared cache entry so EVERY window re-reads the authoritative snapshot at once.
      const result = await invalidate("spin");
      showToast(
        result.ok
          ? { kind: "success", message: "Wallet mirror synced with the ledger." }
          : {
              kind: "error",
              message:
                result.errorStatus === 401
                  ? "Log in to see your wallet."
                  : "Could not reach the cashier — balances may be stale.",
            },
      );
    } finally {
      clearInterval(spinAnimation);
      setIsSpinning(false);
    }
  }, [isSpinning, invalidate, showToast]);

  return (
    <div className="relative w-full max-w-md rounded-3xl border border-amber-500/30 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black p-6 shadow-[0_0_60px_-15px_rgba(245,158,11,0.4)]">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-2xl font-black tracking-widest text-transparent">
          QUEEN&nbsp;ROYAL
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-zinc-500">Mock Slot · {GAME_ID}</p>
      </div>

      {/* Live balances — verbatim ledger strings via the shared chip (skeletons while loading). */}
      <div className="mb-2 grid grid-cols-3 gap-2">
        <BalanceChip family="gc" value={balances?.gc ?? null} stale={phase === "error"} />
        <BalanceChip family="scUnplayed" value={balances?.scUnplayed ?? null} stale={phase === "error"} />
        <BalanceChip family="scRedeemable" value={balances?.scRedeemable ?? null} stale={phase === "error"} />
      </div>
      <WalletStatusBanner phase={phase} errorStatus={errorStatus} lastSyncedAt={lastSyncedAt} />

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
