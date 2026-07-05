/**
 * Compliance footer — omnipresent via the root layout, on every page of the shell.
 *
 * The 18+ / no-purchase-necessary / GC-vs-SC verbiage is a Tier-1 US sweepstakes-operator
 * requirement, not decoration: Gold Coins must be described as valueless entertainment
 * currency, Sweeps Coins as promotional with free methods of entry, and redemptions as
 * prize fulfillment — never as real-money gambling.
 */
export function Footer() {
  return (
    <footer className="border-t border-edge bg-surface-1/60">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-10">
        {/* Headline compliance strip */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-warning text-xs font-black text-warning"
            aria-label="18 plus only"
          >
            18+
          </span>
          <p className="text-sm font-semibold text-ink-mute">
            No purchase necessary. Void where prohibited. QueenRoyal is a social casino for
            entertainment purposes only and does not offer real-money gambling.
          </p>
        </div>

        {/* Sweepstakes-model clarifier */}
        <p className="max-w-4xl text-xs leading-relaxed text-ink-faint">
          Gold Coins (GC) are for entertainment only and have no monetary value. Sweeps Coins
          (SC) may be obtained free of charge via promotions and free methods of entry; unplayed
          Sweeps Coins must be played through before any winnings become redeemable. Eligible
          Sweeps Coins winnings are redeemable for prizes in accordance with the Sweepstakes
          Rules.
        </p>

        {/* Policy links — 44px tap targets (min-h) without inflating the visual line. */}
        <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-6 text-xs font-semibold">
          <a href="#" className="inline-flex min-h-11 items-center text-ink-faint transition hover:text-ink">
            Sweepstakes Rules
          </a>
          <a href="#" className="inline-flex min-h-11 items-center text-ink-faint transition hover:text-ink">
            Terms of Service
          </a>
          <a href="#" className="inline-flex min-h-11 items-center text-ink-faint transition hover:text-ink">
            Privacy Policy
          </a>
          <a href="#" className="inline-flex min-h-11 items-center text-ink-faint transition hover:text-ink">
            Responsible Play
          </a>
        </nav>

        <p className="text-xs text-ink-faint">© 2026 QueenRoyal. Play responsibly.</p>
      </div>
      {/* iOS safe-area: keep the compliance strip clear of the home indicator. */}
      <div aria-hidden="true" className="h-[env(safe-area-inset-bottom)]" />
    </footer>
  );
}
