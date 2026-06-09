import { z } from "zod";

import { moneyString, positiveMoneyString } from "../lib/money";

/**
 * Inbound B2B webhook from an external Game Aggregator (e.g. Pragmatic Play). This is the
 * provider's translated payload — NOT a player request. Money is decimal strings;
 * `provider_transaction_id` is the stable upstream reference we derive deterministic
 * idempotency keys from (`bet:<id>` / `win:<id>`).
 */
export const providerSpinSchema = z.object({
  // Stable per-spin reference from the aggregator → our idempotency anchor.
  provider_transaction_id: z.string().min(1, "provider_transaction_id is required"),
  // The player identifier WE issued to the provider — our local User.id (== engine external_id).
  player_id: z.string().uuid("player_id must be the user UUID we issued to the provider"),
  game_id: z.string().min(1, "game_id is required"),
  round_id: z.string().min(1).optional(),
  currency: z.enum(["GC", "SC"]),
  // Wager: strictly positive decimal string (≤ 4 dp).
  bet_amount: positiveMoneyString,
  // Settlement: non-negative decimal string; "0" (default) means no win this spin.
  win_amount: moneyString.default("0"),
});
export type ProviderSpinInput = z.infer<typeof providerSpinSchema>;
