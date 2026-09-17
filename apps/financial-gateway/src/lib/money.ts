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

/**
 * `123`, `123.4`, `0.0200`, `20000` — integer part required, up to 4 dp, no sign/exp.
 *
 * The integer part is capped at 14 digits to mirror the ledger's `NUMERIC(18,4)` capacity
 * (18 significant digits, 4 after the point → integer part < 10^14), which the Go side
 * enforces as `domain.MaxMoneyUnits`.
 *
 * WHY THE BOUND MATTERS: without it a 30-digit amount passed every check here and only
 * failed at the engine's `UPDATE wallets`, as Postgres 22003 numeric_field_overflow — after
 * the transaction had already taken the wallet's row lock and held it across several
 * round-trips. A cheap request turned into lock contention and an opaque 500. It is also
 * load-bearing for the win cap: a payout is stake × multiplier, so an unbounded stake is an
 * unbounded win however tightly the paytable is capped.
 *
 * No sign is accepted, so `-100` is rejected here before it reaches the ledger.
 */
export const MONEY_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

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

// ─────────────────────────────────────────────────────────────────────────────
// EXACT DECIMAL COMPARISON AND SUMMATION
// ─────────────────────────────────────────────────────────────────────────────
// Policy code has to answer questions like "is this above the cap?" and "would this take the
// player past their daily limit?". Both need arithmetic, and the float ban means the obvious
// tools are all forbidden: `Number("0.1") + Number("0.2")` is 0.30000000000000004, and
// comparing money by `<` after a coercion is the same bug wearing a different hat.
//
// So money is converted to an EXACT INTEGER COUNT OF 1/10,000 UNITS and compared there.
//
// WHY BigInt IS NOT A LOOPHOLE IN THE FLOAT BAN: BigInt is an arbitrary-precision INTEGER
// type. It has no mantissa, no exponent, and no rounding — 0.1 + 0.2 cannot go wrong here
// because neither value is ever represented as a fraction. The string is split at the point
// and the fraction is padded to exactly 4 digits, so "1.5" and "1.5000" produce the identical
// integer and compare equal, which is the behaviour the ledger's NUMERIC(18,4) has. The same
// idiom is already used for IP prefix maths in lib/geo.ts.
//
// Nothing here converts to `number` at any point, including internally.

/** Fractional digits carried by the ledger's NUMERIC(18,4). */
const MONEY_SCALE = 4;

/**
 * A money string as an exact integer count of 1/10,000 units.
 *
 * Throws on a malformed input rather than coercing: a value that failed validation upstream
 * is a bug, and silently treating it as zero would turn that bug into a wrong policy answer.
 */
export function moneyUnits(value: string): bigint {
  if (!isMoneyString(value)) {
    throw new Error(`moneyUnits: not a money string: ${JSON.stringify(value)}`);
  }
  const dot = value.indexOf(".");
  const whole = dot === -1 ? value : value.slice(0, dot);
  const frac = dot === -1 ? "" : value.slice(dot + 1);
  return BigInt(whole + frac.padEnd(MONEY_SCALE, "0"));
}

/** Render an exact unit count back as a canonical money string with 4 dp. */
export function moneyFromUnits(units: bigint): string {
  if (units < 0n) throw new Error(`moneyFromUnits: negative amount: ${units.toString()}`);
  const digits = units.toString().padStart(MONEY_SCALE + 1, "0");
  return `${digits.slice(0, -MONEY_SCALE)}.${digits.slice(-MONEY_SCALE)}`;
}

/**
 * Three-way comparison of two money strings: -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Scale-insensitive by construction, so "10" and "10.0000" compare equal — a lexicographic
 * string compare would get that wrong, and so would every other shortcut.
 */
export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const ua = moneyUnits(a);
  const ub = moneyUnits(b);
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  return 0;
}

/**
 * Exact sum of money strings, returned as a canonical 4 dp money string.
 *
 * Throws if the total exceeds what the ledger can store. A sum that overflows NUMERIC(18,4)
 * is not a number worth returning: it would be rejected downstream as 22003 anyway, and
 * failing here names the cause instead of surfacing it as an opaque ledger error.
 */
export function sumMoney(...values: string[]): string {
  let total = 0n;
  for (const v of values) total += moneyUnits(v);
  const out = moneyFromUnits(total);
  if (!isMoneyString(out)) {
    throw new Error(`sumMoney: total exceeds the ledger's capacity: ${out}`);
  }
  return out;
}
