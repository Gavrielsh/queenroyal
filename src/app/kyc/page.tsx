import type { Metadata } from "next";

export const metadata: Metadata = { title: "Verify your identity — QueenRoyal" };

/**
 * Placeholder landing for the KYC verification flow. The redeem screen links here when the
 * player's `kycStatus` isn't VERIFIED; the actual document-upload/review flow is a separate,
 * unbuilt piece of work (docs/PLAN.md item 3 — the payout provider is a different open item).
 */
export default function KycPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 py-16 text-center">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
        Identity verification
      </h1>
      <p className="mt-4 text-sm text-ink-mute">
        Verification isn&apos;t available yet in this build. Once it launches, you&apos;ll be
        able to confirm your identity here and unlock redemptions.
      </p>
    </main>
  );
}
