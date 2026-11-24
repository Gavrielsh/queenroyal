"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ActionNotice, useActionNotice, type Notice } from "@/components/feedback/ActionNotice";
import { SlotSymbol } from "@/components/game/SlotSymbol";
import { WinCelebration } from "@/components/game/WinCelebration";
import { BalanceChip } from "@/components/wallet/BalanceChip";
import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";
import { useSpinMutation, type SpinFailure } from "@/hooks/useSpinMutation";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import type { SpinCurrency, SpinResultDto } from "@/lib/apiClient";
import { playSound } from "@/lib/sound";
import { winTierFor, type WinTier } from "@/lib/winTier";

/**
 * The player-facing slot window, wired to the SERVER-AUTHORITATIVE spin.
 *
 * ARCHITECTURE NOTE — where an outcome comes from:
 * The browser sends a stake, a currency, a game id, and an idempotency token. That is the
 * entire request; there is no win field to inflate. The engine draws the reels from
 * crypto/rand, evaluates its version-pinned paytable, bounds the payout, and settles the debit
 * and the credit in ONE ledger transaction under ONE wallet lock. The symbols rendered below
 * are the engine's `outcome.reels`, and the balances are re-read from the ledger — this
 * component never computes a win, never deducts optimistically, and never invents a symbol
 * that the ledger did not record.
 *
 * The shuffle during flight is MOTION, not a claim: it is discarded the instant a real outcome
 * arrives, and on any failure the previous settled reels are restored, so the player is never
 * shown a result the ledger did not produce.
 *
 * Motion is CSS-only (the @theme keyframes): the 80ms symbol shuffle supplies CONTENT while
 * `animate-reel-spin` supplies MOTION; on settle each reel lands in turn (`animate-reel-land`,
 * staggered) with a thud. A three-of-a-kind on a high symbol opens the full-screen
 * WinCelebration — its tier comes from the engine's line + symbol, never from the amount.
 */

/**
 * Must match a paytable registered in the engine (`internal/game/paytable.go` → `registry`).
 * The engine REJECTS an unknown game id rather than falling back to a default, so a cosmetic
 * name here would fail every spin with `UNSUPPORTED_GAME`.
 */
const GAME_ID = "classic-3reel";

/** Gold Coins: entertainment-only, and playable at `PENDING` KYC (see lib/kyc-policy.ts). */
const CURRENCY: SpinCurrency = "GC";

/** The stake, as a validated decimal string. Never a number — guardrail G2. */
const BET_AMOUNT = "1.0000";

/**
 * Reel faces while the round is in flight. Presentation only — never a recorded outcome. They
 * are drawn with a `~` prefix so the in-flight DOM can never be mistaken for engine symbol
 * ids (the settled reels carry the bare ids).
 */
const SHUFFLE_SYMBOLS = ["CHERRY", "DIAMOND", "SEVEN", "BELL", "CROWN", "LEMON"] as const;
const SHUFFLE_PREFIX = "~";

const INITIAL_REELS: readonly string[] = ["CROWN", "CROWN", "CROWN"];

/** Reel stagger: each reel lands this long after the one to its left. */
const LAND_STAGGER_MS = 140;

function randomShuffleReels(length: number): string[] {
  return Array.from(
    { length },
    () =>
      SHUFFLE_PREFIX +
      (SHUFFLE_SYMBOLS[Math.floor(Math.random() * SHUFFLE_SYMBOLS.length)] ?? "CROWN"),
  );
}

/** Screen-reader name for a settled symbol id ("DIAMOND" → "Diamond"). */
function symbolLabel(symbol: string): string {
  return symbol.charAt(0) + symbol.slice(1).toLowerCase();
}

/**
 * Copy for a settled round. Money values are the engine's strings, interpolated VERBATIM —
 * rendered, never parsed, never re-formatted (G2).
 *
 * A `CACHED` / `GHOST_RECOVERED` status is surfaced honestly: the player is looking at a round
 * that was already settled, replayed rather than re-drawn, and they were not charged twice.
 * Hiding that would make a recovered round indistinguishable from a fresh one at exactly the
 * moment a player is most likely to be worried about their balance.
 */
function settledNotice(result: SpinResultDto, walletSynced: boolean): Notice {
  const recovered = result.status !== "PROCESSED";
  const won = result.outcome.line !== "NONE";

  const headline = won
    ? `${result.outcome.winSymbol ?? "Line"} pays — you won ${result.winAmount} ${result.family}.`
    : `No win this round. ${result.betAmount} ${result.family} staked.`;

  if (!walletSynced) {
    return {
      kind: "error",
      message: `${headline} The round settled, but the balance re-read failed — figures may be stale.`,
    };
  }
  return {
    kind: recovered ? "error" : "success",
    message: recovered
      ? `${headline} (Recovered an already-settled round — you were not charged twice.)`
      : headline,
  };
}

/** Copy for a failed attempt. Honest about what is and is not known about the player's money. */
function failureNotice(failure: SpinFailure): Notice {
  switch (failure.kind) {
    case "unauthorized":
      return { kind: "error", message: "Log in to spin." };
    case "insufficientFunds":
      return {
        kind: "error",
        message: `Not enough ${CURRENCY} for a ${BET_AMOUNT} stake. Nothing was charged.`,
      };
    case "unavailable":
      // Deliberately does NOT claim the spin failed: it may have settled with the response
      // lost. The retained idempotency token is what makes the reassurance true.
      return {
        kind: "error",
        message:
          "Service temporarily unavailable. If the round did settle, your next attempt recovers it rather than spinning again.",
      };
    case "inFlight":
      return { kind: "error", message: "That spin is still settling — give it a moment." };
    case "declined":
      return { kind: "error", message: failure.message };
  }
}

export function MockGameWindow() {
  const { balances, phase, errorStatus, lastSyncedAt, reconcilePhase, recheckReconcile } =
    useWalletQuery();
  const { notice, showNotice, dismissNotice } = useActionNotice();
  const { spin, isPending, isCoolingDown, isBlocked } = useSpinMutation();

  const [reels, setReels] = useState<readonly string[]>(INITIAL_REELS);
  const [celebration, setCelebration] = useState<{
    tier: WinTier;
    amount: string;
    family: string;
  } | null>(null);
  /** True only while glyphs are shuffling — i.e. the rendered reels are NOT an outcome. */
  const [isShuffling, setIsShuffling] = useState(false);

  // Presentation-only: one settle-pop cycle on the spinning → settled edge.
  const [justSettled, setJustSettled] = useState(false);
  const wasSpinningRef = useRef(false);
  useEffect(() => {
    const wasSpinning = wasSpinningRef.current;
    wasSpinningRef.current = isShuffling;
    if (wasSpinning && !isShuffling) {
      setJustSettled(true);
      const timer = setTimeout(() => setJustSettled(false), 700);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isShuffling]);

  const handleSpin = useCallback(async () => {
    if (isBlocked) return;

    // The last SETTLED reels. Restored verbatim if the attempt fails, so a failure never
    // leaves a fabricated outcome on screen.
    const settledReels = reels;

    playSound("spin");
    setIsShuffling(true);
    const shuffle = setInterval(() => {
      setReels(randomShuffleReels(settledReels.length));
    }, 80);

    try {
      const outcome = await spin({ gameId: GAME_ID, currency: CURRENCY, betAmount: BET_AMOUNT });

      if (outcome.status === "blocked") {
        setReels(settledReels);
        return;
      }

      if (outcome.status === "settled") {
        // The ONLY place reels are set from data: the engine's own record of the round.
        const { result } = outcome;
        setReels(result.outcome.reels);
        showNotice(settledNotice(result, outcome.walletSynced));

        // Sound + celebration, both derived from the outcome record (never from the amount).
        result.outcome.reels.forEach((_, i) => {
          setTimeout(() => playSound("reelStop"), i * LAND_STAGGER_MS);
        });
        const landedMs = result.outcome.reels.length * LAND_STAGGER_MS;
        const tier = winTierFor(result.outcome.line, result.outcome.winSymbol);
        if (tier) {
          setTimeout(
            () => setCelebration({ tier, amount: result.winAmount, family: result.family }),
            landedMs + 200,
          );
        } else if (result.outcome.line !== "NONE") {
          setTimeout(() => playSound("win"), landedMs);
        }
        return;
      }

      // Failed: discard the shuffle, restore the last real outcome, and say what happened.
      setReels(settledReels);
      showNotice(failureNotice(outcome.failure));
    } finally {
      clearInterval(shuffle);
      setIsShuffling(false);
    }
  }, [isBlocked, reels, spin, showNotice]);

  const buttonLabel = isPending
    ? "SPINNING…"
    : isCoolingDown
      ? "UNAVAILABLE — RETRY SHORTLY"
      : `SPIN · ${BET_AMOUNT} ${CURRENCY}`;

  return (
    <div className="relative w-full max-w-md rounded-card border-2 border-gc/40 bg-gradient-to-b from-surface-2 via-surface-1 to-surface-0 p-6 shadow-glow-brand">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="font-display text-3xl font-semibold tracking-wide text-gc drop-shadow-[0_3px_0_rgba(0,0,0,0.35)]">
          QUEEN&nbsp;ROYAL
        </h2>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.3em] text-ink-faint">
          Server-drawn · {GAME_ID}
        </p>
      </div>

      {/* Live balances — verbatim ledger strings via the shared chip (skeletons while loading). */}
      <div className="mb-2 grid grid-cols-3 gap-2">
        <BalanceChip family="gc" value={balances?.gc ?? null} stale={phase === "error"} />
        <BalanceChip family="scUnplayed" value={balances?.scUnplayed ?? null} stale={phase === "error"} />
        <BalanceChip family="scRedeemable" value={balances?.scRedeemable ?? null} stale={phase === "error"} />
      </div>
      <WalletStatusBanner
        phase={phase}
        errorStatus={errorStatus}
        lastSyncedAt={lastSyncedAt}
        reconcilePhase={reconcilePhase}
        onRecheck={recheckReconcile}
      />

      {/* Reels — engine symbols once settled; shuffled glyphs only while in flight. */}
      <div
        aria-label="Reels"
        className="mb-7 grid grid-cols-3 gap-2 rounded-[1.4rem] bg-gradient-to-b from-gold-hi to-gc-deep p-2.5 shadow-candy-gold"
      >
        {reels.map((symbol, i) => (
          <div
            key={i}
            data-testid="reel"
            data-symbol={symbol}
            role="img"
            aria-label={isShuffling ? "Spinning" : symbolLabel(symbol)}
            className="flex aspect-square items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-b from-surface-0 via-surface-3 to-surface-0"
          >
            <SlotSymbol
              symbol={symbol.startsWith(SHUFFLE_PREFIX) ? symbol.slice(SHUFFLE_PREFIX.length) : symbol}
              className={`h-[72%] w-[72%] drop-shadow-[0_4px_4px_rgba(0,0,0,0.35)] ${
                isShuffling ? "animate-reel-spin" : justSettled ? "animate-reel-land" : ""
              }`}
              style={
                isShuffling
                  ? { animationDelay: `${i * 90}ms` }
                  : justSettled
                    ? { animationDelay: `${i * LAND_STAGGER_MS}ms` }
                    : undefined
              }
            />
          </div>
        ))}
      </div>

      {/* Spin button — shimmer sheen while the round is in flight (CSS keyframe overlay). */}
      <button
        type="button"
        onClick={() => void handleSpin()}
        disabled={isBlocked}
        className="btn-candy btn-gold relative w-full overflow-hidden py-4 text-xl tracking-wide"
      >
        {isPending && (
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)] bg-[length:200%_100%]"
          />
        )}
        <span className="relative">{buttonLabel}</span>
      </button>

      <ActionNotice notice={notice} onDismiss={dismissNotice} />

      {celebration && (
        <WinCelebration
          tier={celebration.tier}
          amount={celebration.amount}
          family={celebration.family}
          onClose={() => setCelebration(null)}
        />
      )}
    </div>
  );
}
