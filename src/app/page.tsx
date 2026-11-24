import Link from "next/link";

import { CandyIcon, type CandyIconName } from "@/components/art/CandyIcon";
import { QueenMascot } from "@/components/art/QueenMascot";

/**
 * The three-currency explainer. Copy is sweepstakes legal framing (see the Footer): Gold Coins
 * are valueless entertainment currency, Sweeps Coins are promotional with free entry, and
 * redemptions are prize fulfillment. Card surfaces are chosen so the white body copy stays
 * at or above 4.5:1 on the lightest stop of each gradient.
 */
const EXPLAINERS: ReadonlyArray<{ icon: CandyIconName; title: string; body: string; surface: string }> = [
  {
    icon: "coin",
    title: "Gold Coins",
    body: "The entertainment currency. Spin and play purely for fun — Gold Coins never have monetary value.",
    surface: "bg-gradient-to-br from-[#b45309] to-[#7c2d12]",
  },
  {
    icon: "sc",
    title: "Sweeps Coins",
    body: "Promotional coins granted free with purchases and free methods of entry. Play them through — no purchase ever necessary.",
    surface: "bg-gradient-to-br from-[#047857] to-[#064e3b]",
  },
  {
    icon: "trophy",
    title: "Prize Redemptions",
    body: "Eligible Sweeps Coins winnings become redeemable for real prizes once played through, straight from the ledger.",
    surface: "bg-gradient-to-br from-[#6d28d9] to-[#3b0764]",
  },
];

/**
 * Landing page (Zone 3, server-rendered, static). Pure presentation: brand hero, the
 * sweepstakes-model explainer, and the compliance strip. All money verbiage is display copy
 * bound by the sweepstakes legal framing — no balances, no odds, no financial mocks.
 */
export default function HomePage() {
  return (
    <main className="relative overflow-hidden">
      {/* Hero */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-16 pt-10 sm:pt-14">
        <div className="relative grid items-center gap-6 overflow-hidden rounded-[2rem] border-2 border-white/10 bg-[radial-gradient(circle_at_50%_88%,#a855f7_0%,#7c3aed_24%,#4c1d95_52%,#2e1065_100%)] md:bg-[radial-gradient(circle_at_78%_70%,#a855f7_0%,#7c3aed_24%,#4c1d95_52%,#2e1065_100%)] px-6 pt-8 shadow-glow-brand md:grid-cols-[1.05fr_1fr] md:px-10 md:pt-10">
          <div className="relative z-10 pb-8 text-center md:pb-12 md:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/25 py-1 pl-1.5 pr-3 text-sm font-extrabold text-ink">
              <CandyIcon name="crown" className="h-6 w-6" />
              The social sweepstakes casino
            </span>
            <h1 className="mt-4 font-display text-5xl font-semibold leading-none tracking-tight text-ink sm:text-7xl">
              Queen<span className="text-gc">Royal</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base font-semibold leading-relaxed text-[#ede4ff] sm:text-lg md:mx-0">
              The social sweepstakes casino floor. Spin for fun with Gold Coins, play promotional
              Sweeps Coins free of charge — and redeem eligible winnings for real prizes.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-4 md:justify-start">
              <Link href="/casino" className="btn-candy btn-gold px-7 py-4 text-lg">
                <CandyIcon name="slot" className="-my-2 h-8 w-8" />
                Enter the Casino Floor
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex min-h-11 items-center rounded-control border-2 border-white/25 px-6 py-3 font-display text-base font-medium text-ink transition hover:border-white/50"
              >
                How it works
              </a>
            </div>

            <p className="mt-6 text-xs font-bold uppercase tracking-wider text-[#ede4ff]">
              18+ · No purchase necessary · Void where prohibited
            </p>
          </div>

          <QueenMascot className="relative mx-auto w-full max-w-md self-end" />
        </div>
      </section>

      {/* Sweepstakes-model explainer */}
      <section id="how-it-works" className="mx-auto w-full max-w-6xl px-4 pb-24">
        <h2 className="mb-6 text-center font-display text-3xl font-semibold text-ink">How it works</h2>
        <div className="grid gap-5 md:grid-cols-3">
          {EXPLAINERS.map((card) => (
            <article
              key={card.title}
              className={`group rounded-card border-2 border-white/10 p-7 shadow-lift ${card.surface}`}
            >
              <CandyIcon
                name={card.icon}
                className="h-16 w-16 drop-shadow-[0_6px_8px_rgba(0,0,0,0.35)] group-hover:animate-wiggle"
              />
              <h3 className="mt-4 font-display text-xl font-semibold text-ink">{card.title}</h3>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-ink">{card.body}</p>
            </article>
          ))}
        </div>

        {/* Trust strip — honest engineering claims only. Every line here must name
            something a reader could verify in the running product TODAY.

            "Responsible play tools" was removed. No player-facing deposit, loss or
            session limit, self-exclusion, cool-off or reality-check exists in any zone:
            there is no route a player can call and no UI that reaches one. (The engine's
            user_status enum carries a SUSPENDED value whose comment mentions
            self-exclusion, but nothing ever sets it for that reason — a status value is
            not a tool.) Responsible gaming is Phase 3 in ROADMAP.md.

            Advertising player-protection tooling that does not exist is the most harmful
            false claim this page could carry: a player at risk could choose the product
            BECAUSE of it. Restore the line only when the tools ship and are reachable
            from the UI — not when they are merely planned. */}
        <div className="mt-10 grid gap-4 rounded-card border-2 border-edge bg-surface-1/70 p-6 text-center sm:grid-cols-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Double-entry ledger accuracy
          </p>
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Balances read live — never computed in your browser
          </p>
        </div>
      </section>
    </main>
  );
}
