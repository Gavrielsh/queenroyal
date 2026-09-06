"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ActionNotice, useActionNotice, type Notice } from "@/components/feedback/ActionNotice";
import { BalanceChip } from "@/components/wallet/BalanceChip";
import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";
import { useSpinMutation, type SpinFailure } from "@/hooks/useSpinMutation";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import type { FeedbackClass, SpinCurrency, SpinResultDto } from "@/lib/apiClient";

import { SpinFeedback } from "./feedback/SpinFeedback";

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
 * `animate-reel-spin` supplies MOTION; the settle pop is a class swap driven by isSpinning.
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

/** Reel faces while the round is in flight. Presentation only — never a recorded outcome. */
const SHUFFLE_GLYPHS = ["🍒", "💎", "7️⃣", "🔔", "👑", "🍋"] as const;

/**
 * Engine symbol id → glyph. Ids are the audit record (they are written into the ledger
 * transaction's metadata); the glyph is pure decoration. An unmapped id renders a neutral
 * placeholder rather than throwing — a new symbol shipped by the engine must never break the
 * window that has to display it.
 */
const SYMBOL_GLYPHS: Readonly<Record<string, string>> = {
  CHERRY: "🍒",
  LEMON: "🍋",
  BELL: "🔔",
  DIAMOND: "💎",
  SEVEN: "7️⃣",
  CROWN: "👑",
};
const UNKNOWN_GLYPH = "❔";

const INITIAL_REELS: readonly string[] = ["CROWN", "CROWN", "CROWN"];

function glyphFor(symbol: string): string {
  return SYMBOL_GLYPHS[symbol] ?? UNKNOWN_GLYPH;
}

function randomShuffleReels(length: number): string[] {
  return Array.from(
    { length },
    () => SHUFFLE_GLYPHS[Math.floor(Math.random() * SHUFFLE_GLYPHS.length)] ?? "👑",
  );
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

  // GATE C. The headline is chosen from the ENGINE's feedback class, never from
  // the outcome line or the win amount.
  //
  // This previously read `result.outcome.line !== "NONE"` and rendered
  // "<SYMBOL> pays — you won <amount>" with success styling. On classic-3reel a
  // leading CHERRY or LEMON pair pays x1: the stake comes back and nothing more,
  // and those two outcomes are 10.99% of all spins. So roughly one spin in ten
  // congratulated the player on breaking even — a textbook loss disguised as a
  // win, in the copy rather than in the sound.
  //
  // The NEUTRAL wording states the payout honestly without implying a gain. The
  // amounts are still shown, because a player who watched a pair land is owed
  // the figure; what they are not owed is being told they won it.
  const headline = ((): string => {
    switch (result.feedbackClass) {
      case "WIN":
        return `${result.outcome.winSymbol ?? "Line"} pays — you won ${result.winAmount} ${result.family}.`;
      case "NEUTRAL":
        return `${result.outcome.winSymbol ?? "Line"} pays ${result.winAmount} ${result.family} — your ${result.betAmount} stake, returned. You broke even.`;
      case "LOSS":
        return `No win this round. ${result.betAmount} ${result.family} staked.`;
    }
  })();

  if (!walletSynced) {
    return {
      kind: "error",
      message: `${headline} The round settled, but the balance re-read failed — figures may be stale.`,
    };
  }
  // `success` is the celebratory notice styling, so it is reserved for a genuine
  // WIN. A NEUTRAL or LOSS round renders in the neutral style: the round
  // settled correctly, and that is a statement of fact, not an achievement.
  return {
    kind: recovered ? "error" : result.feedbackClass === "WIN" ? "success" : "neutral",
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
  /** True only while glyphs are shuffling — i.e. the rendered reels are NOT an outcome. */
  const [isShuffling, setIsShuffling] = useState(false);

  /**
   * The engine's feedback class for the last settled round, or null before the
   * first spin.
   *
   * GATE C: this is stored VERBATIM from the response and never recomputed. It
   * is the sole input to <SpinFeedback>, which is the only component allowed to
   * celebrate. Nothing here inspects winAmount or the outcome line to decide how
   * the round felt.
   */
  const [feedbackClass, setFeedbackClass] = useState<FeedbackClass | null>(null);

  // Presentation-only: one settle-pop cycle on the spinning → settled edge.
  // NOT a celebration — it fires on every settle, win or lose, and says only
  // that the reels stopped. See src/components/feedback/celebration.ts.
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
        setReels(outcome.result.outcome.reels);
        setFeedbackClass(outcome.result.feedbackClass);
        showNotice(settledNotice(outcome.result, outcome.walletSynced));
        return;
      }

      // Failed: discard the shuffle, restore the last real outcome, and say what happened.
      // The previous verdict is cleared too — a stale WIN must not keep celebrating a
      // round that is no longer the one being shown.
      setReels(settledReels);
      setFeedbackClass(null);
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
    <div className="relative w-full max-w-md rounded-card border border-gc/30 bg-gradient-to-b from-surface-1 via-surface-0 to-black p-6 shadow-glow-gc">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-gc via-yellow-200 to-gc bg-clip-text text-2xl font-black tracking-widest text-transparent">
          QUEEN&nbsp;ROYAL
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-ink-faint">
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
        className="mb-6 flex justify-center gap-3 rounded-card border border-edge bg-surface-1/80 p-4"
      >
        {reels.map((symbol, i) => (
          <div
            key={i}
            data-testid="reel"
            data-symbol={symbol}
            style={isShuffling ? { animationDelay: `${i * 90}ms` } : undefined}
            className={`flex h-20 w-20 items-center justify-center rounded-chip border text-4xl shadow-inner ${
              isShuffling
                ? "animate-reel-spin border-edge-strong bg-gradient-to-b from-surface-3 to-surface-1"
                : `border-edge bg-gradient-to-b from-surface-3 to-surface-1 ${
                    justSettled ? "animate-settle-pop border-gc/50" : ""
                  }`
            }`}
          >
            {isShuffling ? symbol : glyphFor(symbol)}
          </div>
        ))}
      </div>

      {/*
        GATE C. The single celebratory surface in the application. It receives the
        engine's class and nothing else — no amount, no line, no multiplier — so it
        cannot decide for itself that a stake-returning round was a win.
      */}
      {feedbackClass !== null && !isShuffling && <SpinFeedback feedbackClass={feedbackClass} />}

      {/* Spin button — shimmer sheen while the round is in flight (CSS keyframe overlay). */}
      <button
        type="button"
        onClick={() => void handleSpin()}
        disabled={isBlocked}
        className="relative w-full overflow-hidden rounded-control bg-gradient-to-r from-gc via-yellow-400 to-gc py-4 text-lg font-black tracking-widest text-surface-0 shadow-glow-gc transition active:scale-[0.98] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
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
    </div>
  );
}
