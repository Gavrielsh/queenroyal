import Link from "next/link";
import type { ReactNode } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { SoundToggle } from "@/components/shell/SoundToggle";

/**
 * Global top bar (server component; the account menu is its one client island).
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
          className="group flex min-h-11 items-center gap-2 rounded-control px-1 py-1 sm:gap-2.5"
          aria-label="QueenRoyal home"
        >
          <CandyIcon
            name="crown"
            className="h-8 w-8 drop-shadow-[0_0_10px_rgba(255,200,61,0.45)] transition group-hover:animate-wiggle sm:h-9 sm:w-9"
          />
          <span className="font-display text-xl font-semibold tracking-tight text-ink max-[359px]:hidden sm:text-2xl">
            Queen<span className="text-gc">Royal</span>
          </span>
        </Link>

        <div className="flex items-center gap-1.5 sm:gap-3">
          {walletSlot}
          <SoundToggle />
          <AccountMenu />
          <Link href="/casino" className="btn-candy btn-violet min-h-11 whitespace-nowrap px-4 text-sm sm:px-5">
            <CandyIcon name="slot" className="-my-1 hidden h-7 w-7 sm:block" />
            {/* Phone width holds the logo, sound, "Log in" and this only with the short label. */}
            <span className="sm:hidden">Play</span>
            <span className="hidden sm:inline">Casino Floor</span>
          </Link>
        </div>
      </nav>
    </header>
  );
}
