"use client";

import { MockGameWindow } from "@/components/MockGameWindow";
import { useWalletStore } from "@/store/useWalletStore";

/**
 * Casino floor test page. Mounts the mock slot against the live wallet mirror.
 * The mirror starts empty — in production it is hydrated from the gateway after
 * login; the dev-only seed button below substitutes for that during E2E testing.
 */
export default function CasinoPage() {
  const setBalances = useWalletStore((s) => s.setBalances);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-black px-4 py-16">
      <MockGameWindow />

      {process.env.NODE_ENV !== "production" && (
        <button
          type="button"
          onClick={() => setBalances(1_000, 25, 5)}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-xs uppercase tracking-wider text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
        >
          Dev: seed wallet mirror (1,000 GC / 25 SC / 5 SC)
        </button>
      )}
    </main>
  );
}
