import type { Currency } from "@/types/true-engine";

/**
 * Server-side KYC gating for money-mutating paths. The decision is made from the
 * player's CURRENT status in our database — never from a (potentially stale) claim
 * baked into a long-lived JWT.
 *
 * Policy (centralized here so it is easy to audit/adjust):
 *   - REJECTED        → always blocked (any money movement).
 *   - PURCHASE        → require VERIFIED (real-money entry point).
 *   - SPIN, SC family → require VERIFIED (SC carries redeemable/sweeps value).
 *   - SPIN, GC family → allow PENDING (Gold Coins are entertainment-only), block REJECTED.
 *
 * NOTE: For B2B spin webhooks the ideal gate is at game-launch / session creation; this
 * settlement-time check is a backstop so an un-cleared player can never accrue SC value.
 */
export type KycAction = "PURCHASE" | "SPIN";

export class KycGateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KycGateError";
  }
}

export function assertKycAllows(kycStatus: string, action: KycAction, currency?: Currency): void {
  if (kycStatus === "REJECTED") {
    throw new KycGateError("KYC_REJECTED", "Account KYC was rejected; transactions are blocked");
  }

  const requiresVerified = action === "PURCHASE" || currency === "SC";
  if (requiresVerified && kycStatus !== "VERIFIED") {
    throw new KycGateError("KYC_REQUIRED", "KYC verification is required for this action");
  }
}
