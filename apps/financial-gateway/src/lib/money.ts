import { z } from "zod";

/**
 * Money is represented EVERYWHERE in this gateway as a validated decimal **string** in
 * whole-coin units with at most 4 fractional digits — mirroring the True Engine's
 * `NUMERIC(18,4)` / JSON-string wire format (`internal/domain/money.go`).
 *
 * HARD RULES (see .claude-instructions / ARCHITECTURE.md):
 *   - NEVER coerce money to a JS `number` (`Number`, `parseFloat`, `parseInt`, `z.number()`).
 *     JS floats are forbidden, and integer "minor units" are ALSO wrong — the engine is
 *     decimal, not cents.
 *   - Validate the shape, reject > 4 decimal places (mirrors `ErrMoneyScaleExceeded`), and
 *     forward the string verbatim to the engine.
 */

/** `123`, `123.4`, `0.0200`, `20000` — integer part required, up to 4 dp, no sign/exp. */
export const MONEY_REGEX = /^\d+(\.\d{1,4})?$/;

/** A non-negative decimal string with ≤ 4 dp. */
export function isMoneyString(v: unknown): v is string {
  return typeof v === "string" && MONEY_REGEX.test(v);
}

/**
 * True iff the value is a valid money string AND strictly greater than zero. Implemented
 * without any float parse: the only characters are digits and a dot, so the presence of any
 * non-zero digit means the value is > 0.
 */
export function isPositiveMoneyString(v: unknown): v is string {
  return isMoneyString(v) && /[1-9]/.test(v);
}

/**
 * Format a trusted whole-coin integer (from the store catalog) as a money string. Throws on a
 * non-integer / negative input so a bad catalog constant fails loudly rather than silently
 * shipping a malformed amount to the ledger.
 */
export function wholeCoinsToMoneyString(coins: number): string {
  if (!Number.isInteger(coins) || coins < 0) {
    throw new Error(`wholeCoinsToMoneyString: expected a non-negative integer, got ${coins}`);
  }
  return String(coins);
}

/** Zod: a non-negative money string (allows "0"). */
export const moneyString = z
  .string()
  .regex(MONEY_REGEX, "Amount must be a decimal string with at most 4 decimal places");

/** Zod: a strictly-positive money string (engine bet/win/redeem require amount > 0). */
export const positiveMoneyString = moneyString.refine(isPositiveMoneyString, {
  message: "Amount must be greater than 0",
});
