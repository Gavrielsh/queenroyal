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

/**
 * Inbound B2B ROLLBACK webhook from a Game Aggregator: void/cancel a previously-placed BET
 * after the provider's game state crashes or a player disconnects catastrophically. Like the
 * spin webhook this is the provider's translated payload (already HMAC/timestamp/nonce verified
 * at the perimeter) — NOT a player request.
 *
 * NOTE on the two ids:
 *   - `provider_transaction_id` is THIS rollback's own upstream reference (distinct from the
 *     bet's). It is diagnostic/audit only — the engine idempotency anchor is derived from the
 *     ORIGINAL bet so a provider rollback and an internal win-compensation of the same bet
 *     collapse to one reversal (see processProviderRollback).
 *   - `reference_transaction_id` is the ORIGINAL bet's `provider_transaction_id`. The gateway
 *     resolves it to that bet's engine `ledger_transaction_id` (via the intent journal) before
 *     calling the engine, which reverses strictly by ledger id.
 */
export const providerRollbackSchema = z.object({
  provider_transaction_id: z.string().min(1, "provider_transaction_id is required"),
  // The player identifier WE issued to the provider — our local User.id (== engine external_id).
  player_id: z.string().uuid("player_id must be the user UUID we issued to the provider"),
  reference_transaction_id: z.string().min(1, "reference_transaction_id is required"),
});
export type ProviderRollbackInput = z.infer<typeof providerRollbackSchema>;
