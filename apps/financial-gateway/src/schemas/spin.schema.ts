import { z } from "zod";

import { positiveMoneyString } from "../lib/money";

/**
 * Player-initiated spin request (Zone 3 → gateway).
 *
 * SECURITY — read the absent fields as carefully as the present ones. There is no
 * `win_amount`, no `multiplier`, no `outcome`, and no `reels`. The player says only how much
 * they want to stake and which game; the ENGINE draws the result from crypto/rand and derives
 * the payout from its own version-pinned paytable.
 *
 * This closes the audit's critical finding: previously the only spin path ran through the B2B
 * webhook, whose `win_amount` was caller-supplied and unbounded. Anyone holding a provider
 * HMAC secret could credit arbitrary SC_REDEEMABLE — the currency that converts to cash.
 *
 * Do not add a win-shaped field here. The Go side has a structural test
 * (TestSpinRequestHasNoWinField) asserting the same property on its request struct.
 */
export const spinSchema = z.object({
  /**
   * Client-supplied per-attempt idempotency key. REQUIRED, like the cashier's: a
   * server-minted key would break crash-safe retry, since a retried request would mint a NEW
   * spin instead of resuming the journaled one. The gateway derives the engine's
   * `operator_transaction_id` from it as `spin:<key>`.
   */
  idempotencyKey: z.string().min(8).max(200),
  currency: z.enum(["GC", "SC"]),
  /** The stake — the ONLY monetary value the player controls. Validated as a decimal string. */
  betAmount: positiveMoneyString,
  /** Optional game selector. The engine rejects an unknown id rather than defaulting. */
  gameId: z.string().min(1).max(64).optional(),
});
export type SpinInput = z.infer<typeof spinSchema>;
