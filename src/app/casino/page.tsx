"use client";

import { DevAutoLogin } from "@/components/DevAutoLogin";
import { MockGameWindow } from "@/components/MockGameWindow";
import { StoreWindow } from "@/components/StoreWindow";
import { MetaFloor } from "@/components/meta/MetaFloor";
import { anyMetaFeatureOn } from "@/lib/meta/features";

/**
 * Casino floor. Mounts the mock slot and the coin store against the SAME live wallet cache —
 * a purchase settled through the gateway shows up in both, because both only render what the
 * ledger last reported.
 * DevAutoLogin holds both windows back until a gateway session exists (dev only), so their
 * mount-time `GET /api/wallet` hydration is always authenticated. There is still no way to
 * seed balances locally, by design: a fabricated balance is a financial mock, and the
 * execution contract forbids those even in dev.
 */
export default function CasinoPage() {
  // Meta-game layout (lobby, wheel, missions, VIP…) only when a meta feature is switched on —
  // never in production today; see lib/meta/features.ts.
  if (anyMetaFeatureOn()) {
    return (
      <DevAutoLogin>
        <MetaFloor />
      </DevAutoLogin>
    );
  }

  return (
    <DevAutoLogin>
      <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:py-14">
        <header className="text-center sm:text-left">
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Casino Floor
          </h1>
          <p className="mt-2 text-sm text-ink-mute">
            Every balance below is read live from the ledger — nothing is computed in your
            browser.
          </p>
        </header>

        <div className="mt-10 grid grid-cols-1 place-items-center gap-10 xl:grid-cols-2 xl:place-items-start xl:justify-items-center">
          <MockGameWindow />
          <StoreWindow />
        </div>
      </main>
    </DevAutoLogin>
  );
}
