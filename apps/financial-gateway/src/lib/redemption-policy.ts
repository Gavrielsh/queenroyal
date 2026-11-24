import { compareMoney, isPositiveMoneyString, sumMoney } from "./money";

/**
 * redemption-policy — every rule that decides whether a redemption MAY be requested.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions over facts handed to them. Nothing here reads a database, calls the engine,
 * looks at a clock, or holds state; the same inputs always produce the same decision. That is
 * not stylistic preference — a payout rule is the thing a regulator asks you to demonstrate,
 * and a rule you can only observe by standing up a database and an HTTP client is a rule you
 * cannot cheaply prove. Here every branch is one function call away from an assertion.
 *
 * Each rule is also exported on its own, so a failing case names the rule that failed rather
 * than "the policy said no".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * It is NOT the authority on any of the facts it evaluates, and it deliberately cannot be:
 *
 *   - It never asks "can the player afford this?". SC_REDEEMABLE lives in Zone 1 and the
 *     engine answers that question when the debit is attempted. A balance check here would
 *     be a second opinion about money, which this zone is not allowed to have.
 *   - It does not DETERMINE playthrough; it refuses when the outstanding figure it is GIVEN
 *     is non-zero. The engine re-checks and is the one that can actually refuse the debit
 *     (ErrPlaythroughOutstanding). Checking here is a courtesy that avoids sending a call
 *     that is already known to be doomed — not a substitute for the engine's own gate.
 *
 * A pre-flight refusal that disagrees with the engine costs a player a confusing error. A
 * pre-flight APPROVAL that disagrees with the engine costs nothing, because the engine still
 * refuses. The asymmetry is why this module is allowed to exist at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABSOLUTE FLOAT BAN
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no `Number`, no `parseFloat`, no `+`/`<`/`>` on money anywhere in this file. Every
 * monetary comparison goes through `compareMoney`/`sumMoney` (lib/money), which work on exact
 * integer counts of 1/10,000 units. A cap check performed in floating point is not a cap: it
 * is a cap that is occasionally off by one unit in the player's favour, or the operator's,
 * depending on the bits.
 */

/** Why a redemption was refused. Stable strings — they reach logs and support tooling. */
export type RedemptionRefusal =
  | "JURISDICTION_NOT_PERMITTED"
  | "KYC_NOT_VERIFIED"
  | "PLAYER_NOT_ACTIVE"
  | "PLAYTHROUGH_OUTSTANDING"
  | "BELOW_MINIMUM"
  | "ABOVE_PER_REQUEST_CAP"
  | "DAILY_CAP_EXCEEDED"
  | "MONTHLY_CAP_EXCEEDED";

/**
 * The monetary bounds that apply to one redemption, all as decimal strings.
 *
 * DATA, NOT CODE. No state's figures appear anywhere in this module: the caller supplies the
 * table, and this file only compares against whatever it is handed. Sweepstakes prize limits
 * differ per state and change by legislature, not by release — a rule baked into a function
 * body would make a legal change a code change, which is exactly the coupling that gets an
 * operator caught out mid-quarter.
 */
export interface RedemptionCaps {
  /** Smallest redemption the operator will process. */
  minimumAmount: string;
  /** Largest single redemption. */
  maximumPerRequest: string;
  /** Ceiling on the sum of redemptions in the current day. */
  dailyCap: string;
  /** Ceiling on the sum of redemptions in the current month. */
  monthlyCap: string;
}

/**
 * Caps keyed by jurisdiction, with a fallback.
 *
 * An entry mapped to `null` is a jurisdiction where redemption is NOT PERMITTED AT ALL. That
 * is deliberately distinct from "absent": absent means "nothing special, use the default",
 * while null is a positive statement that this jurisdiction is closed. Encoding a prohibition
 * as a missing key is how a prohibition gets silently lost in a merge.
 */
export interface RedemptionCapTable {
  default: RedemptionCaps;
  byJurisdiction?: Readonly<Record<string, RedemptionCaps | null>>;
}

/** Everything the policy needs to know. Gathered by the caller; never fetched here. */
export interface RedemptionFacts {
  /** ISO country-region, as the geo fence produces it (e.g. "US-NJ"). */
  jurisdiction: string;
  /** Our local KYC state for the player. */
  kycStatus: string;
  /** The engine's player status (ACTIVE / SUSPENDED / SELF_EXCLUDED / KYC_PENDING / CLOSED). */
  playerStatus: string;
  /** SC still owed to the 1x playthrough requirement. "0" means discharged. */
  playthroughOutstanding: string;
  /** The amount being requested. */
  amount: string;
  /** Sum of redemptions already counted against today. */
  redeemedToday: string;
  /** Sum of redemptions already counted against this month. */
  redeemedThisMonth: string;
}

export type RedemptionDecision =
  | { allowed: true; caps: RedemptionCaps }
  | { allowed: false; refusals: readonly [RedemptionRefusal, ...RedemptionRefusal[]] };

// ─────────────────────────────────────────────────────────────────────────────
// Individual rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the caps for a jurisdiction. Returns null when redemption is not permitted there.
 *
 * Keys are compared case-insensitively and trimmed, because the geo fence's region value
 * arrives from an edge header and header casing is not something to bet a prize limit on.
 */
export function capsFor(table: RedemptionCapTable, jurisdiction: string): RedemptionCaps | null {
  const key = jurisdiction.trim().toUpperCase();
  const byJurisdiction = table.byJurisdiction;
  if (byJurisdiction && Object.prototype.hasOwnProperty.call(byJurisdiction, key)) {
    // Present-but-null is an explicit prohibition; present-with-caps overrides the default.
    return byJurisdiction[key] ?? null;
  }
  return table.default;
}

/** Redemption converts sweeps value to cash value, so nothing short of VERIFIED will do. */
export function kycAllowsRedemption(kycStatus: string): boolean {
  return kycStatus === "VERIFIED";
}

/**
 * ACTIVE only. Every other status is a refusal, and the two that matter most are the ones
 * Phase A made enforceable: a SUSPENDED player is under review, and a SELF_EXCLUDED player
 * asked us to stop — paying either one out is precisely the failure those controls exist to
 * prevent. KYC_PENDING and CLOSED fall out of the same rule without needing their own clause.
 */
export function playerStatusAllowsRedemption(playerStatus: string): boolean {
  return playerStatus === "ACTIVE";
}

/** Discharged means exactly zero outstanding — "0", "0.0000" and "0.00" all qualify. */
export function playthroughDischarged(outstanding: string): boolean {
  return compareMoney(outstanding, "0") === 0;
}

/** At or above the floor. The minimum is inclusive: asking for exactly the minimum is fine. */
export function meetsMinimum(amount: string, caps: RedemptionCaps): boolean {
  return compareMoney(amount, caps.minimumAmount) >= 0;
}

/** At or below the single-request ceiling, inclusive. */
export function withinPerRequestCap(amount: string, caps: RedemptionCaps): boolean {
  return compareMoney(amount, caps.maximumPerRequest) <= 0;
}

/**
 * Would this request, ADDED to what the period already holds, stay within the cap?
 *
 * The addition is the whole point: checking the request alone against a period cap would let
 * a player clear it any number of times a day. Inclusive, so landing exactly on the cap is
 * allowed and the next request is not.
 */
export function withinPeriodCap(amount: string, alreadyRedeemed: string, cap: string): boolean {
  return compareMoney(sumMoney(amount, alreadyRedeemed), cap) <= 0;
}

export function withinDailyCap(amount: string, redeemedToday: string, caps: RedemptionCaps): boolean {
  return withinPeriodCap(amount, redeemedToday, caps.dailyCap);
}

export function withinMonthlyCap(amount: string, redeemedThisMonth: string, caps: RedemptionCaps): boolean {
  return withinPeriodCap(amount, redeemedThisMonth, caps.monthlyCap);
}

// ─────────────────────────────────────────────────────────────────────────────
// The composed decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate every rule and return ALL refusals, ordered: who the player is first, then what
 * they asked for.
 *
 * Every applicable rule is evaluated rather than stopping at the first failure. A support
 * agent looking at a refused redemption wants the whole picture — "unverified AND over the
 * daily cap" is a different conversation from either one alone — and a caller that only wants
 * the headline reads `refusals[0]`, which the ordering makes the most significant one.
 *
 * The one short circuit is jurisdiction: with no caps resolved there is nothing to measure an
 * amount against, so reporting amount refusals would mean inventing a cap to compare with.
 *
 * THROWS on a malformed or non-positive `amount`. That is not a policy question — it is an
 * upstream validation failure (the route's `positiveMoneyString`), and a policy that quietly
 * treated a malformed amount as zero would answer a question nobody asked.
 */
export function evaluateRedemption(facts: RedemptionFacts, table: RedemptionCapTable): RedemptionDecision {
  if (!isPositiveMoneyString(facts.amount)) {
    throw new Error(`evaluateRedemption: amount must be a positive money string, got ${JSON.stringify(facts.amount)}`);
  }

  const caps = capsFor(table, facts.jurisdiction);
  if (caps === null) {
    return { allowed: false, refusals: ["JURISDICTION_NOT_PERMITTED"] };
  }

  const refusals: RedemptionRefusal[] = [];
  if (!kycAllowsRedemption(facts.kycStatus)) refusals.push("KYC_NOT_VERIFIED");
  if (!playerStatusAllowsRedemption(facts.playerStatus)) refusals.push("PLAYER_NOT_ACTIVE");
  if (!playthroughDischarged(facts.playthroughOutstanding)) refusals.push("PLAYTHROUGH_OUTSTANDING");
  if (!meetsMinimum(facts.amount, caps)) refusals.push("BELOW_MINIMUM");
  if (!withinPerRequestCap(facts.amount, caps)) refusals.push("ABOVE_PER_REQUEST_CAP");
  if (!withinDailyCap(facts.amount, facts.redeemedToday, caps)) refusals.push("DAILY_CAP_EXCEEDED");
  if (!withinMonthlyCap(facts.amount, facts.redeemedThisMonth, caps)) refusals.push("MONTHLY_CAP_EXCEEDED");

  const [first, ...rest] = refusals;
  return first === undefined ? { allowed: true, caps } : { allowed: false, refusals: [first, ...rest] };
}
