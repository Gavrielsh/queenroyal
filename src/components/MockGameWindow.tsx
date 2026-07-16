"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ActionNotice, useActionNotice } from "@/components/feedback/ActionNotice";
import { BalanceChip } from "@/components/wallet/BalanceChip";
import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import { armReconcile } from "@/lib/walletReconcile";

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
 * Motion is CSS-only (the @theme keyframes): the existing 80ms symbol shuffle supplies
 * CONTENT while `animate-reel-spin` supplies MOTION; the settle pop is a class swap driven
 * by the existing isSpinning state. No new JS animation loops.
 */
const GAME_ID = "mock-slot-1";

const REEL_SYMBOLS = ["🍒", "💎", "7️⃣", "🔔", "👑", "🍋"] as const;

export function MockGameWindow() {
  const { balances, phase, errorStatus, lastSyncedAt, invalidate } = useWalletQuery();
  const { notice, showNotice, dismissNotice } = useActionNotice();

  const [isSpinning, setIsSpinning] = useState(false);
  const [reels, setReels] = useState<readonly [string, string, string]>(["👑", "👑", "👑"]);

  // Presentation-only: one settle-pop cycle when a spin ends (spinning → settled edge).
  const [justSettled, setJustSettled] = useState(false);
  const wasSpinningRef = useRef(false);
  useEffect(() => {
    const wasSpinning = wasSpinningRef.current;
    wasSpinningRef.current = isSpinning;
    if (wasSpinning && !isSpinning) {
      setJustSettled(true);
      const timer = setTimeout(() => setJustSettled(false), 700);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isSpinning]);

  const handleSpin = useCallback(async () => {
    if (isSpinning) return;
    setIsSpinning(true);

    // Pre-spin baseline: the snapshot the (out-of-band) round's settlement must move away
    // from. Captured before the settle window opens.
    const baseline = balances;

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
      // After the (out-of-band) round settles, the ledger may have changed: reconcile until
      // its answer differs from the pre-spin baseline. The invalidation below IS poll #1.
      armReconcile(baseline, { trigger: "spin" });
      const result = await invalidate("spin");
      showNotice(
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
  }, [isSpinning, balances, invalidate, showNotice]);

  return (
    <div className="relative w-full max-w-md rounded-card border border-gc/30 bg-gradient-to-b from-surface-1 via-surface-0 to-black p-6 shadow-glow-gc">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-gc via-yellow-200 to-gc bg-clip-text text-2xl font-black tracking-widest text-transparent">
          QUEEN&nbsp;ROYAL
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-ink-faint">Mock Slot · {GAME_ID}</p>
      </div>

      {/* Live balances — verbatim ledger strings via the shared chip (skeletons while loading). */}
      <div className="mb-2 grid grid-cols-3 gap-2">
        <BalanceChip family="gc" value={balances?.gc ?? null} stale={phase === "error"} />
        <BalanceChip family="scUnplayed" value={balances?.scUnplayed ?? null} stale={phase === "error"} />
        <BalanceChip family="scRedeemable" value={balances?.scRedeemable ?? null} stale={phase === "error"} />
      </div>
      <WalletStatusBanner phase={phase} errorStatus={errorStatus} lastSyncedAt={lastSyncedAt} />

      {/* Reels — content shuffled by the existing interval, MOTION supplied purely by CSS. */}
      <div className="mb-6 flex justify-center gap-3 rounded-card border border-edge bg-surface-1/80 p-4">
        {reels.map((symbol, i) => (
          <div
            key={i}
            style={isSpinning ? { animationDelay: `${i * 90}ms` } : undefined}
            className={`flex h-20 w-20 items-center justify-center rounded-chip border text-4xl shadow-inner ${
              isSpinning
                ? "animate-reel-spin border-edge-strong bg-gradient-to-b from-surface-3 to-surface-1"
                : `border-edge bg-gradient-to-b from-surface-3 to-surface-1 ${
                    justSettled ? "animate-settle-pop border-gc/50" : ""
                  }`
            }`}
          >
            {symbol}
          </div>
        ))}
      </div>

      {/* Spin button — shimmer sheen while the round is in flight (CSS keyframe overlay). */}
      <button
        type="button"
        onClick={() => void handleSpin()}
        disabled={isSpinning}
        className="relative w-full overflow-hidden rounded-control bg-gradient-to-r from-gc via-yellow-400 to-gc py-4 text-lg font-black tracking-widest text-surface-0 shadow-glow-gc transition active:scale-[0.98] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSpinning && (
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)] bg-[length:200%_100%]"
          />
        )}
        <span className="relative">{isSpinning ? "SPINNING…" : "SPIN (settles provider-side)"}</span>
      </button>

      <ActionNotice notice={notice} onDismiss={dismissNotice} />
    </div>
  );
}
