"use client";

import { useEffect, useRef, useState } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";
import { formatBalance } from "@/lib/format";
import { playSound } from "@/lib/sound";
import { TIER_STEPS, type WinTier } from "@/lib/winTier";

/**
 * Full-screen celebration for a big settled win: the headline escalates BIG → MEGA → EPIC up
 * to the tier the engine's outcome earned, coins rain, then the win amount lands.
 *
 * The amount is the engine's settled `winAmount` STRING, formatted with the same string-only
 * formatter as every balance — never parsed, never counted up digit by digit (G2). By the
 * time this opens the ledger has already credited the win; the button only closes the
 * overlay, so its copy never implies the player has to "collect" anything.
 */
export interface WinCelebrationProps {
  tier: WinTier;
  /** Engine decimal string, verbatim. */
  amount: string;
  /** Currency family as the engine reported it ("GC" | "SC"). */
  family: string;
  onClose: () => void;
}

/** Deterministic coin rain (index-derived positions): no randomness, stable across renders. */
const COINS = Array.from({ length: 18 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: ((i * 7) % 12) / 10,
  duration: 2.2 + ((i * 5) % 7) / 5,
  size: 22 + ((i * 11) % 18),
}));

const STEP_MS = 750;

export function WinCelebration({ tier, amount, family, onClose }: WinCelebrationProps) {
  const lastStep = TIER_STEPS.findIndex((step) => step.tier === tier);
  const [step, setStep] = useState(0);
  const revealed = step >= lastStep;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escalate one headline at a time, with a sting per step.
  useEffect(() => {
    playSound(step === 0 ? "bigWin" : "tier");
    if (step >= lastStep) return undefined;
    const timer = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [step, lastStep]);

  useEffect(() => {
    if (revealed) closeRef.current?.focus();
  }, [revealed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const headline = TIER_STEPS[Math.min(step, lastStep)]?.label ?? "BIG WIN";
  const tierColor = ["#FFC83D", "#FF4FA3", "#3BE39B"][Math.min(step, lastStep)];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="win-celebration-title"
      data-testid="win-celebration"
      className="fixed inset-0 z-[60] grid place-items-center overflow-hidden bg-[#0e0420]/90 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -ml-[500px] -mt-[500px] h-[1000px] w-[1000px] animate-rays rounded-full bg-[repeating-conic-gradient(rgb(255_200_61/0.18)_0deg_8deg,transparent_8deg_22.5deg)] [mask-image:radial-gradient(circle,#000_12%,transparent_60%)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {COINS.map((coin, i) => (
          <span
            key={i}
            className="absolute -top-12 block motion-safe:animate-[qr-coin-rain_linear_infinite]"
            style={{
              left: `${coin.left}%`,
              width: coin.size,
              height: coin.size,
              animationDelay: `${coin.delay}s`,
              animationDuration: `${coin.duration}s`,
            }}
          >
            <CandyIcon name="coin" className="h-full w-full" />
          </span>
        ))}
      </div>

      <div className="relative grid justify-items-center gap-3 text-center">
        <p
          key={headline}
          id="win-celebration-title"
          className="animate-tier-pop font-display text-6xl font-bold leading-none sm:text-8xl"
          style={{
            color: tierColor,
            WebkitTextStroke: "3px #fff",
            paintOrder: "stroke fill",
            textShadow: `0 5px 0 rgba(0,0,0,.35), 0 0 40px ${tierColor}`,
          }}
        >
          {headline}
        </p>
        {revealed && (
          <>
            <p className="animate-tier-pop font-display text-5xl font-semibold tabular-nums text-ink sm:text-6xl">
              {formatBalance(amount)} <span className="text-gc">{family}</span>
            </p>
            <p className="text-sm font-bold text-ink-mute">Already added to your balance by the ledger.</p>
            <button ref={closeRef} type="button" onClick={onClose} className="btn-candy btn-gold mt-2 px-10 py-3.5 text-xl">
              Awesome!
            </button>
          </>
        )}
      </div>
    </div>
  );
}
