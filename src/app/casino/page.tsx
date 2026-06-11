"use client";

import { MockGameWindow } from "@/components/MockGameWindow";
import { StoreWindow } from "@/components/StoreWindow";

/**
 * Casino floor test page. Mounts the mock slot and the coin store against the SAME live
 * wallet mirror — a purchase settled through the gateway shows up in both, because both only
 * render what the ledger last reported.
 * The mirror hydrates itself from the gateway (`GET /api/wallet`) on mount — there is no
 * way to seed it locally, by design: a fabricated balance in the mirror is a financial
 * mock, and the execution contract forbids those even in dev.
 */
export default function CasinoPage() {
  return (
    <main className="flex min-h-screen flex-wrap items-center justify-center gap-10 bg-black px-4 py-16">
      <MockGameWindow />
      <StoreWindow />
    </main>
  );
}
