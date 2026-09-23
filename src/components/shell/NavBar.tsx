import Link from "next/link";
import type { ReactNode } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";
import { SoundToggle } from "@/components/shell/SoundToggle";

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
          className="group flex min-h-11 items-center gap-2.5 rounded-control px-1 py-1"
          aria-label="QueenRoyal home"
        >
          <CandyIcon
            name="crown"
            className="h-9 w-9 drop-shadow-[0_0_10px_rgba(255,200,61,0.45)] transition group-hover:animate-wiggle"
          />
          <span className="font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            Queen<span className="text-gc">Royal</span>
          </span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          {walletSlot}
          <SoundToggle />
          <Link href="/casino" className="btn-candy btn-violet min-h-11 px-4 text-sm sm:px-5">
            <CandyIcon name="slot" className="-my-1 hidden h-7 w-7 sm:block" />
            Casino Floor
          </Link>
        </div>
      </nav>
    </header>
  );
}
