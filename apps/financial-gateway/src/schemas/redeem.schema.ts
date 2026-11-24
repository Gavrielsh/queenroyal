import { z } from "zod";

import { positiveMoneyString } from "../lib/money";

/**
 * POST /api/store/redeem body.
 *
 * `amount` IS A STRING AND ONLY A STRING. `positiveMoneyString` is built on `z.string()`, so a
 * native JSON number is rejected by type before any regex runs — `{"amount": 125.5}` never
 * reaches the service, let alone the ledger. That matters more here than anywhere else in the
 * gateway: JSON.parse has already turned 125.5 into an IEEE-754 double by the time we see it,
 * and no amount of care downstream can recover a scale the parse destroyed. The only safe
 * moment to refuse a number is the first one.
 *
 * The regex then bounds it to the ledger's NUMERIC(18,4) and rejects zero, negatives,
 * exponent notation and a 5th decimal place.
 */
export const redeemSchema = z.object({
  amount: positiveMoneyString,
  // REQUIRED client-supplied attempt token, exactly as the purchase route requires one. It
  // anchors the engine debit's operator_transaction_id (`redeem:<key>`), so a double-submit
  // reaches the same journaled intent instead of debiting twice. A server-minted fallback
  // would silently break the client's crash-safe retry semantics.
  idempotencyKey: z.string().min(8).max(200),
});

export type RedeemInput = z.infer<typeof redeemSchema>;
