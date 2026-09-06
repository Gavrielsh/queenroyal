/**
 * The celebration module — Gate C.
 *
 * THIS MODULE IS QUARANTINED. `SpinFeedback` is the only file permitted to
 * import it, and that restriction is enforced by ESLint
 * (`no-restricted-imports` in eslint.config.mjs), not by convention.
 *
 * WHY QUARANTINE IT AT ALL
 *
 * A celebration is not a styling choice, it is a claim about the player's
 * money: this round left you better off. On classic-3reel that claim is false
 * for 10.99% of paying spins — a leading CHERRY or LEMON pair returns the stake
 * exactly and nothing more. The engine already decides who may be congratulated
 * and ships a `feedbackClass`; the risk that remains is a component deciding for
 * itself, which is one `winAmount !== "0.0000"` away in any file that can import
 * a sound.
 *
 * So there is exactly one door, and the lint rule is the lock. Everything in
 * here requires a WIN verdict that came from the engine, and nothing in here can
 * be reached from a component that has not gone through SpinFeedback.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * The reels' `animate-settle-pop` is NOT a celebration and does not belong in
 * this module. It fires when the reels stop, on every round, win or lose — it
 * says "the spin resolved", not "you won". Moving it in here would make the lint
 * rule meaningless by putting a neutral animation behind the celebration door.
 */

/**
 * The CSS class that marks a celebratory flourish.
 *
 * Exported as a constant rather than written inline so the LDW tests can assert
 * its ABSENCE by name: a test that greps for a hardcoded string silently stops
 * working the day somebody renames the class, which is precisely when a
 * regression would slip through.
 */
export const WIN_CELEBRATION_CLASS = "animate-pulse-glow";

/**
 * Test seam. Counts celebrations so a unit test can assert that nothing fired,
 * which is the assertion that matters here — "no sound was emitted" is not
 * observable from the DOM alone.
 */
let celebrationCount = 0;

/** How many celebrations have been triggered since the last reset. Test-only. */
export function celebrationsTriggered(): number {
  return celebrationCount;
}

/** Resets the counter between tests. Test-only. */
export function resetCelebrations(): void {
  celebrationCount = 0;
}

/**
 * Plays the win sound.
 *
 * Guarded by `feedbackClass === "WIN"` at the single call site in SpinFeedback.
 * The guard is not repeated here on purpose: two places that both decide whether
 * a round is a win is two places that can disagree, and the engine is the one
 * that decides. This function's contract is "the caller has an engine WIN" — the
 * lint rule is what guarantees there is only one caller to audit.
 *
 * Audio is best-effort. A blocked autoplay policy or a missing device must never
 * break a settled round: the money already moved, and a silent celebration is a
 * far better outcome than a thrown error in the render path.
 */
export function playWinCelebration(): void {
  celebrationCount += 1;

  if (typeof window === "undefined" || typeof window.Audio === "undefined") {
    return;
  }
  try {
    const audio = new window.Audio("/sounds/win.mp3");
    audio.volume = 0.4;
    void audio.play().catch(() => {
      // Autoplay policies reject un-gestured playback. Expected, not an error.
    });
  } catch {
    // Audio construction can throw in restricted environments. Never fatal.
  }
}
