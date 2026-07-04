import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Global top bar (server component — zero client JS of its own).
 *
 * `walletSlot` is the reserved region for the live wallet summary. It renders NOTHING until
 * M3-T4 wires the real `useWalletQuery` chip into it — the no-financial-mocks rule applies
 * to chrome too: an empty slot is honest, a hardcoded balance is a financial mock.
 */
export function NavBar({ walletSlot }: { walletSlot?: ReactNode }) {
  return (
    <header className="sticky top-0 z-50 border-b border-edge bg-surface-0/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <Link
          href="/"
          className="group flex items-center gap-2.5 rounded-control px-1 py-1"
          aria-label="QueenRoyal home"
        >
          <span
            aria-hidden="true"
            className="bg-gradient-to-b from-gc to-gc-deep bg-clip-text text-2xl leading-none text-transparent transition group-hover:brightness-125"
          >
            ♛
          </span>
          <span className="text-lg font-black tracking-[0.18em] text-ink">
            QUEEN<span className="text-gc">ROYAL</span>
          </span>
        </Link>

        <div className="flex items-center gap-3">
          {walletSlot}
          <Link
            href="/casino"
            className="rounded-control border border-edge bg-surface-2 px-4 py-2 text-xs font-bold uppercase tracking-widest text-ink-mute transition hover:border-edge-strong hover:text-ink"
          >
            Casino Floor
          </Link>
        </div>
      </nav>
    </header>
  );
}
