"use client";

import { DevAutoLogin } from "@/components/DevAutoLogin";
import { MockGameWindow } from "@/components/MockGameWindow";
import { StoreWindow } from "@/components/StoreWindow";

/**
 * Casino floor test page. Mounts the mock slot and the coin store against the SAME live
 * wallet mirror — a purchase settled through the gateway shows up in both, because both only
 * render what the ledger last reported.
 * DevAutoLogin holds both windows back until a gateway session exists (dev only), so their
 * mount-time `GET /api/wallet` hydration is always authenticated. There is still no way to
 * seed the mirror locally, by design: a fabricated balance in the mirror is a financial
 * mock, and the execution contract forbids those even in dev.
 */
export default function CasinoPage() {
  return (
    <DevAutoLogin>
      <main className="flex min-h-screen flex-wrap items-center justify-center gap-10 bg-black px-4 py-16">
        <MockGameWindow />
        <StoreWindow />
      </main>
    </DevAutoLogin>
  );
}
