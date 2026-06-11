"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient, ApiError } from "@/lib/apiClient";
import {
  InsufficientFundsError,
  useWalletStore,
  type Currency,
} from "@/store/useWalletStore";

/** Wager every spin of the mock slot places against the gateway ledger. */
const SPIN_COST = 10;
const SPIN_CURRENCY: Currency = "GC";
const GAME_ID = "mock-slot-1";

interface BetRequest {
  amount: number;
  currency: Currency;
  gameId: string;
}

/**
 * Settled-bet response from the gateway. The ledger is the source of truth, so
 * the gateway echoes back the exact post-bet balances and we overwrite the
 * local mirror with them.
 */
interface BetResponse {
  balances: {
    gc: number;
    scUnplayed: number;
    scRedeemable: number;
  };
  winAmount?: number;
}

interface Toast {
  kind: "error" | "success";
  message: string;
}

const REEL_SYMBOLS = ["🍒", "💎", "7️⃣", "🔔", "👑", "🍋"] as const;

function formatBalance(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Mock slot machine used to exercise the end-to-end bet flow against the
 * financial gateway: optimistic deduct → POST /bet → sync-or-rollback.
 */
export function MockGameWindow() {
  const gcBalance = useWalletStore((s) => s.gcBalance);
  const scUnplayed = useWalletStore((s) => s.scUnplayed);
  const scRedeemable = useWalletStore((s) => s.scRedeemable);

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

    const { optimisticDeduct, setBalances } = useWalletStore.getState();

    // (a) Optimistic deduction — the UI drops the wager instantly.
    let rollback: () => void;
    try {
      rollback = optimisticDeduct(SPIN_COST, SPIN_CURRENCY);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        showToast({ kind: "error", message: "Insufficient GC balance — visit the cashier." });
        return;
      }
      throw error;
    }

    setIsSpinning(true);
    const spinAnimation = setInterval(() => {
      setReels([
        REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)] ?? "👑",
        REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)] ?? "👑",
        REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)] ?? "👑",
      ]);
    }, 80);

    try {
      // (b) Settle the bet against the gateway ledger.
      const result = await apiClient.post<BetResponse>("/bet", {
        amount: SPIN_COST,
        currency: SPIN_CURRENCY,
        gameId: GAME_ID,
      } satisfies BetRequest);

      // (c) Success — the ledger's numbers win; overwrite the optimistic mirror.
      setBalances(result.balances.gc, result.balances.scUnplayed, result.balances.scRedeemable);

      if (result.winAmount && result.winAmount > 0) {
        showToast({ kind: "success", message: `WINNER! +${formatBalance(result.winAmount)} GC` });
      }
    } catch (error) {
      // (d) Rejection — undo the optimistic deduction and tell the player.
      rollback();
      const message =
        error instanceof ApiError && error.code === "INSUFFICIENT_FUNDS"
          ? "Insufficient funds — the ledger rejected this bet."
          : error instanceof ApiError && error.status === 0
            ? "Connection lost — your balance was not charged."
            : "Spin failed — your balance was not charged.";
      showToast({ kind: "error", message });
    } finally {
      clearInterval(spinAnimation);
      setIsSpinning(false);
    }
  }, [isSpinning, showToast]);

  return (
    <div className="relative w-full max-w-md rounded-3xl border border-amber-500/30 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black p-6 shadow-[0_0_60px_-15px_rgba(245,158,11,0.4)]">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-2xl font-black tracking-widest text-transparent">
          QUEEN&nbsp;ROYAL
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-zinc-500">Mock Slot · {GAME_ID}</p>
      </div>

      {/* Live balances (read straight from the wallet mirror) */}
      <div className="mb-6 grid grid-cols-3 gap-2">
        <BalanceChip label="GC" value={gcBalance} accent="text-amber-300" />
        <BalanceChip label="SC Unplayed" value={scUnplayed} accent="text-emerald-300" />
        <BalanceChip label="SC Redeemable" value={scRedeemable} accent="text-sky-300" />
      </div>

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
        {isSpinning ? "SPINNING…" : `SPIN (Cost: ${SPIN_COST} ${SPIN_CURRENCY})`}
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

function BalanceChip({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-2 py-2 text-center">
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`truncate text-sm font-bold tabular-nums ${accent}`}>{formatBalance(value)}</p>
    </div>
  );
}
