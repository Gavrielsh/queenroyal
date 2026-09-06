"use client";

import { useEffect } from "react";

import type { FeedbackClass } from "@/lib/apiClient";

import { WIN_CELEBRATION_CLASS, playWinCelebration } from "./celebration";

/**
 * SpinFeedback — Gate C, Zone 3.
 *
 * The ONLY component permitted to trigger a celebratory sound or animation, and
 * the only file permitted to import `./celebration` (enforced by
 * `no-restricted-imports` in eslint.config.mjs).
 *
 * IT TAKES A CLASS, NOT AMOUNTS — DELIBERATELY
 *
 * The props are `feedbackClass` and nothing else. No bet, no win, no multiplier,
 * no outcome line. That is the whole design: a component that cannot see the
 * numbers cannot be tempted to interpret them, and the interpretation is exactly
 * where losses-disguised-as-wins come from.
 *
 * The tempting bug is one line long and looks reasonable in review:
 *
 *     const won = result.winAmount !== "0.0000";        // WRONG
 *     const won = result.outcome.line !== "NONE";       // ALSO WRONG
 *
 * Both are true for a leading CHERRY or LEMON pair, which pays x1 — the stake
 * back, nothing gained. Those two outcomes are 10.99% of every spin on
 * classic-3reel. This component cannot express either bug, because it is never
 * given `winAmount` or `line` to test.
 *
 * The engine computes `netPosition = totalReturn - totalStake` and derives the
 * class from its sign, with WIN requiring strictly greater than zero. See
 * `internal/domain/feedback.go`.
 */
export interface SpinFeedbackProps {
  /**
   * The engine's verdict. The complete input to this component.
   *
   * Do NOT add amount props here. If a future design needs to show a figure
   * alongside the celebration, render it in a sibling component: the value of
   * this one is precisely that it has nothing to compute.
   */
  feedbackClass: FeedbackClass;
}

/**
 * Copy per class.
 *
 * NEUTRAL is the case this gate exists for and its wording is load-bearing. It
 * must be honest that a payout happened without implying a gain — "you won"
 * would be false, and hiding the round entirely would be its own dishonesty,
 * because the player watched a pair land and is owed an explanation of what it
 * was worth. "Stake returned" is the accurate description: something came back,
 * and it was exactly what went in.
 */
const COPY: Record<FeedbackClass, string> = {
  WIN: "You won this round.",
  NEUTRAL: "Stake returned — you broke even on this round.",
  LOSS: "No win this round.",
};

/**
 * `data-feedback` is the stable hook the LDW tests assert against. Exposing the
 * class the component actually rendered with — rather than inferring it from
 * copy — means the assertions keep working when the wording changes, and a
 * wording change is the most likely future edit here.
 */
export function SpinFeedback({ feedbackClass }: SpinFeedbackProps) {
  const isWin = feedbackClass === "WIN";

  // THE SINGLE CELEBRATION TRIGGER IN THE APPLICATION.
  //
  // Strict equality against the engine's verdict. Not `!== "LOSS"`, which would
  // sweep NEUTRAL in with the wins and reintroduce the exact defect this gate
  // bans — an LDW is neither a loss nor a win, and treating "not a loss" as
  // cause to celebrate is how it usually happens.
  useEffect(() => {
    if (feedbackClass === "WIN") {
      playWinCelebration();
    }
  }, [feedbackClass]);

  return (
    <p
      data-testid="spin-feedback"
      data-feedback={feedbackClass}
      className={`text-sm font-semibold ${
        isWin ? `text-success ${WIN_CELEBRATION_CLASS}` : "text-muted"
      }`}
    >
      {COPY[feedbackClass]}
    </p>
  );
}
