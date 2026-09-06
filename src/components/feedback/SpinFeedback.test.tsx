import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpinFeedback } from "@/components/feedback/SpinFeedback";
import type { FeedbackClass } from "@/lib/apiClient";

import { WIN_CELEBRATION_CLASS, celebrationsTriggered, resetCelebrations } from "./celebration";

/**
 * Gate C, Zone 3 — the losses-disguised-as-wins enumeration.
 *
 * WHAT IS BEING ENUMERATED
 *
 * Every outcome of classic-3reel where `0 < totalReturn <= totalStake`: a payout
 * happened, and the player is no better off for it. The paytable below mirrors
 * the engine's `internal/game/paytable.go` — Zone 3 does not own game math, and
 * this table is here to enumerate cases, never to compute a result. The engine
 * ships the verdict; this suite checks the UI honours it.
 *
 * For classic-3reel the qualifying set is exactly two outcomes — a leading
 * CHERRY pair and a leading LEMON pair, both paying x1 — and together they are
 * 10.99% of all spins. That is the size of the problem this gate exists for:
 * more than one spin in ten pays out while leaving the player exactly where they
 * started.
 */

/** The engine's published table. Mirror of internal/game/paytable.go. */
const CLASSIC_3REEL = [
  { id: "CHERRY", weight: 30, payThree: 5, payTwo: 1 },
  { id: "LEMON", weight: 25, payThree: 10, payTwo: 1 },
  { id: "BELL", weight: 20, payThree: 20, payTwo: 2 },
  { id: "DIAMOND", weight: 13, payThree: 50, payTwo: 4 },
  { id: "SEVEN", weight: 8, payThree: 130, payTwo: 8 },
  { id: "CROWN", weight: 4, payThree: 400, payTwo: 15 },
] as const;

interface EnumeratedOutcome {
  label: string;
  reels: [string, string, string];
  multiplier: number;
}

/**
 * Every reel triple, scored by the engine's line rules: three of a kind pays
 * PayThree; reels 1 and 2 matching (only) pays PayTwo; anything else pays
 * nothing. Reels 2+3 matching pays nothing — the line reads left to right.
 */
function enumerateOutcomes(): EnumeratedOutcome[] {
  const out: EnumeratedOutcome[] = [];
  for (const a of CLASSIC_3REEL) {
    for (const b of CLASSIC_3REEL) {
      for (const c of CLASSIC_3REEL) {
        let multiplier = 0;
        if (a.id === b.id && b.id === c.id) {
          multiplier = a.payThree;
        } else if (a.id === b.id) {
          multiplier = a.payTwo;
        }
        out.push({
          label: `${a.id}/${b.id}/${c.id}`,
          reels: [a.id, b.id, c.id],
          multiplier,
        });
      }
    }
  }
  return out;
}

/** Stakes to score each outcome at. The class must depend on the sign alone. */
const STAKES = [0.0001, 0.25, 1, 2.5, 100, 10_000];

/**
 * The classifier, mirroring `internal/domain/feedback.go`. Used ONLY to decide
 * which class the engine would have sent for an enumerated outcome, so the test
 * can feed the component the right input. The component itself never does this.
 */
function classify(net: number): FeedbackClass {
  if (net > 0) return "WIN";
  if (net === 0) return "NEUTRAL";
  return "LOSS";
}

/**
 * Copy that asserts a gain. If any of these renders for a non-WIN round, the UI
 * is telling the player they won something they did not.
 */
const POSITIVE_FRAMING = [/you won/i, /congratulations/i, /nice win/i, /winner/i, /you win\b/i];

/**
 * Stub the audio element.
 *
 * jsdom has no media stack, so a real `new Audio(...).play()` logs
 * "Not implemented: HTMLMediaElement's play() method" on every celebration. The
 * noise is harmless but it trains people to ignore this suite's output, and
 * these tests are about what does and does not fire — the one suite where a
 * reader should trust every line.
 *
 * Whether the sound actually PLAYS is a browser concern, covered by the E2E
 * suite. What matters here is whether the celebration was TRIGGERED, which
 * `celebrationsTriggered()` reports independently of the audio device.
 */
class SilentAudio {
  volume = 0;
  play(): Promise<void> {
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.stubGlobal("Audio", SilentAudio);
  resetCelebrations();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCelebrations();
});

describe("Gate C — no celebration on a net-zero or net-negative round", () => {
  const outcomes = enumerateOutcomes();

  // The enumeration must be the shape we think it is, or everything below is
  // asserting over the wrong set.
  it("enumerates the full outcome space", () => {
    expect(outcomes).toHaveLength(6 ** 3);
  });

  it("finds exactly the two known stake-returning outcomes", () => {
    const ldw = outcomes.filter((o) => o.multiplier > 0 && o.multiplier <= 1);
    const labels = [...new Set(ldw.map((o) => `${o.reels[0]}+${o.reels[1]} pair`))].sort();
    expect(labels).toEqual(["CHERRY+CHERRY pair", "LEMON+LEMON pair"]);
    expect(ldw.length).toBeGreaterThan(0);
  });

  /**
   * THE GATE. Every enumerated outcome whose return is positive but does not
   * exceed the stake is rendered, and the three ways a celebration can leak are
   * each checked: sound, animation class, and copy.
   */
  it("renders no celebration for any outcome where 0 < totalReturn <= totalStake", () => {
    let cases = 0;

    for (const outcome of outcomes) {
      for (const stake of STAKES) {
        const totalReturn = outcome.multiplier * stake;
        if (!(totalReturn > 0 && totalReturn <= stake)) continue;
        cases += 1;

        const feedbackClass = classify(totalReturn - stake);

        // The engine must classify these NEUTRAL. If this fails, the mirrored
        // classifier and the engine disagree and the rest is meaningless.
        expect(feedbackClass).toBe("NEUTRAL");

        resetCelebrations();
        const { container, unmount } = render(<SpinFeedback feedbackClass={feedbackClass} />);

        // 1. NO WIN SOUND.
        expect(
          celebrationsTriggered(),
          `${outcome.label} at stake ${stake} returned ${totalReturn} and triggered a celebration`,
        ).toBe(0);

        // 2. NO WIN ANIMATION CLASS.
        expect(
          container.querySelector(`.${WIN_CELEBRATION_CLASS}`),
          `${outcome.label} at stake ${stake} applied the win animation`,
        ).toBeNull();

        // 3. NO POSITIVE-FRAMING COPY.
        const text = container.textContent ?? "";
        for (const pattern of POSITIVE_FRAMING) {
          expect(
            pattern.test(text),
            `${outcome.label} at stake ${stake} rendered positive framing: ${text}`,
          ).toBe(false);
        }

        // And the rendered element must declare the class it was given, so the
        // E2E suite has a stable hook.
        expect(screen.getByTestId("spin-feedback")).toHaveAttribute("data-feedback", "NEUTRAL");

        unmount();
      }
    }

    // A loop that matched nothing would pass every assertion above. Since
    // classic-3reel demonstrably has stake-returning outcomes, zero cases means
    // the enumeration broke, not that the game got safer.
    expect(cases, "no stake-returning cases were enumerated").toBeGreaterThan(0);
  });

  it("renders no celebration for a losing round", () => {
    const { container } = render(<SpinFeedback feedbackClass="LOSS" />);
    expect(celebrationsTriggered()).toBe(0);
    expect(container.querySelector(`.${WIN_CELEBRATION_CLASS}`)).toBeNull();
    for (const pattern of POSITIVE_FRAMING) {
      expect(pattern.test(container.textContent ?? "")).toBe(false);
    }
  });

  /**
   * The counter-case. Without it every assertion above would still pass if the
   * component simply never celebrated anything — which would be a different bug,
   * and one this suite would otherwise call a success.
   */
  it("DOES celebrate a genuine win, so the assertions above are not vacuous", () => {
    const { container } = render(<SpinFeedback feedbackClass="WIN" />);
    expect(celebrationsTriggered()).toBe(1);
    expect(container.querySelector(`.${WIN_CELEBRATION_CLASS}`)).not.toBeNull();
    expect(POSITIVE_FRAMING.some((p) => p.test(container.textContent ?? ""))).toBe(true);
  });

  it("states the payout honestly on a stake-returning round without implying a gain", () => {
    render(<SpinFeedback feedbackClass="NEUTRAL" />);
    const text = screen.getByTestId("spin-feedback").textContent ?? "";
    // Honest that something happened...
    expect(text.toLowerCase()).toContain("returned");
    // ...without claiming a gain.
    expect(/you won/i.test(text)).toBe(false);
  });

  /**
   * NEUTRAL must be handled as its own case, not folded in with WIN by a
   * `!== "LOSS"` test. That specific mistake is the most likely way this
   * regresses, so it is asserted directly rather than left to the other cases.
   */
  it("treats NEUTRAL as distinct from WIN, not merely as 'not a loss'", () => {
    const { container: neutral, unmount } = render(<SpinFeedback feedbackClass="NEUTRAL" />);
    const neutralCelebrations = celebrationsTriggered();
    const neutralHasWinClass = neutral.querySelector(`.${WIN_CELEBRATION_CLASS}`) !== null;
    unmount();

    resetCelebrations();
    const { container: win } = render(<SpinFeedback feedbackClass="WIN" />);

    expect(neutralCelebrations).toBe(0);
    expect(neutralHasWinClass).toBe(false);
    expect(celebrationsTriggered()).toBe(1);
    expect(win.querySelector(`.${WIN_CELEBRATION_CLASS}`)).not.toBeNull();
  });
});
