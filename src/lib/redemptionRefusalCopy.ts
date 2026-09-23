/**
 * Player-facing copy for every `RedemptionRefusal` code
 * (apps/financial-gateway/src/lib/redemption-policy.ts). The gateway's `refusalError()` puts
 * the most significant refusal in `error.code` verbatim, so this is a direct lookup — no
 * inference, no guessing which rule fired.
 */

export const REDEMPTION_REFUSAL_CODES = [
  "JURISDICTION_NOT_PERMITTED",
  "KYC_NOT_VERIFIED",
  "PLAYER_NOT_ACTIVE",
  "PLAYTHROUGH_OUTSTANDING",
  "BELOW_MINIMUM",
  "ABOVE_PER_REQUEST_CAP",
  "DAILY_CAP_EXCEEDED",
  "MONTHLY_CAP_EXCEEDED",
] as const;

export type RedemptionRefusalCode = (typeof REDEMPTION_REFUSAL_CODES)[number];

export function isRedemptionRefusalCode(code: string | null): code is RedemptionRefusalCode {
  return code !== null && (REDEMPTION_REFUSAL_CODES as readonly string[]).includes(code);
}

/** Distinct, actionable copy per code — never a generic "redemption refused". */
export const REDEMPTION_REFUSAL_COPY: Readonly<Record<RedemptionRefusalCode, string>> = {
  JURISDICTION_NOT_PERMITTED: "Redemption isn't available in your state.",
  KYC_NOT_VERIFIED: "Verify your identity to redeem — see the KYC link below.",
  PLAYER_NOT_ACTIVE: "Your account can't redeem right now. Contact support for details.",
  PLAYTHROUGH_OUTSTANDING: "You still have a playthrough requirement to clear before redeeming.",
  BELOW_MINIMUM: "That's below the minimum redemption amount.",
  ABOVE_PER_REQUEST_CAP: "That's above the maximum for a single redemption request.",
  DAILY_CAP_EXCEEDED: "That would put you over today's redemption limit.",
  MONTHLY_CAP_EXCEEDED: "That would put you over this month's redemption limit.",
};
