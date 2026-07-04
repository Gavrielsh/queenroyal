import Link from "next/link";

/**
 * Landing page (Zone 3, server-rendered, static). Pure presentation: brand hero, the
 * sweepstakes-model explainer, and the compliance strip. All money verbiage is display copy
 * bound by the sweepstakes legal framing — no balances, no odds, no financial mocks.
 */
export default function HomePage() {
  return (
    <main className="relative overflow-hidden">
      {/* Hero */}
      <section className="relative mx-auto w-full max-w-6xl px-4 pb-20 pt-24 text-center sm:pt-32">
        {/* Ambient glow behind the crown — pure decoration. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-80 max-w-3xl rounded-full bg-gc/10 blur-3xl"
        />

        <span
          aria-hidden="true"
          className="relative inline-block bg-gradient-to-b from-gc to-gc-deep bg-clip-text text-6xl text-transparent drop-shadow-[0_0_25px_rgba(245,182,46,0.35)]"
        >
          ♛
        </span>
        <h1 className="relative mt-4 bg-gradient-to-r from-gc via-yellow-200 to-gc bg-clip-text text-5xl font-black tracking-tight text-transparent sm:text-7xl">
          QueenRoyal
        </h1>
        <p className="relative mx-auto mt-5 max-w-2xl text-base leading-relaxed text-ink-mute sm:text-lg">
          The social sweepstakes casino floor. Spin for fun with Gold Coins, play promotional
          Sweeps Coins free of charge — and redeem eligible winnings for real prizes.
        </p>

        <div className="relative mt-9 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/casino"
            className="rounded-control bg-gradient-to-r from-gc via-yellow-400 to-gc px-8 py-4 text-sm font-black uppercase tracking-widest text-surface-0 shadow-glow-gc transition hover:brightness-110 active:scale-[0.98]"
          >
            Enter the Casino Floor
          </Link>
          <a
            href="#how-it-works"
            className="rounded-control border border-edge px-6 py-4 text-sm font-bold uppercase tracking-widest text-ink-mute transition hover:border-edge-strong hover:text-ink"
          >
            How it works
          </a>
        </div>

        <p className="relative mt-6 text-xs font-semibold uppercase tracking-wider text-ink-faint">
          18+ · No purchase necessary · Void where prohibited
        </p>
      </section>

      {/* Sweepstakes-model explainer */}
      <section id="how-it-works" className="mx-auto w-full max-w-6xl px-4 pb-24">
        <div className="grid gap-5 md:grid-cols-3">
          <article className="rounded-card border border-edge bg-surface-1 p-7">
            <p className="text-2xl" aria-hidden="true">
              🪙
            </p>
            <h2 className="mt-3 text-sm font-black uppercase tracking-widest text-gc">
              Gold Coins
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-mute">
              The entertainment currency. Spin and play purely for fun — Gold Coins never have
              monetary value.
            </p>
          </article>

          <article className="rounded-card border border-edge bg-surface-1 p-7">
            <p className="text-2xl" aria-hidden="true">
              🎟️
            </p>
            <h2 className="mt-3 text-sm font-black uppercase tracking-widest text-sc-unplayed">
              Sweeps Coins
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-mute">
              Promotional coins granted free with purchases and free methods of entry. Play them
              through — no purchase ever necessary.
            </p>
          </article>

          <article className="rounded-card border border-edge bg-surface-1 p-7">
            <p className="text-2xl" aria-hidden="true">
              🏆
            </p>
            <h2 className="mt-3 text-sm font-black uppercase tracking-widest text-sc-redeemable">
              Prize Redemptions
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-mute">
              Eligible Sweeps Coins winnings become redeemable for real prizes once played
              through, straight from the ledger.
            </p>
          </article>
        </div>

        {/* Trust strip — honest engineering claims only. */}
        <div className="mt-10 grid gap-4 rounded-card border border-edge bg-surface-1/60 p-6 text-center sm:grid-cols-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Double-entry ledger accuracy
          </p>
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Balances read live — never computed in your browser
          </p>
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Responsible play tools
          </p>
        </div>
      </section>
    </main>
  );
}
