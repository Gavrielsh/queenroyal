/**
 * The free-entry rules, as pure predicates over facts gathered elsewhere.
 *
 * Same shape and the same reasoning as lib/redemption-policy: nothing here reads a database,
 * calls the engine, looks at a clock it was not handed, or knows where a fact came from. That
 * is what makes the rules testable without standing up infrastructure, and auditable by
 * someone reading one file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS GATE IS DELIBERATELY NARROWER THAN THE REDEMPTION GATE
 * ─────────────────────────────────────────────────────────────────────────────
 * The instinct on a route that issues free currency is to gate it hard. That instinct is
 * wrong here, and getting it wrong in the strict direction is the more dangerous mistake.
 *
 * The Alternative Method of Entry is not a promotion. It is the element that makes this
 * platform a sweepstakes rather than a lottery: consideration is what separates the two, and
 * the free route is the answer to the consideration question. Every condition attached to it
 * is a condition attached to the legal basis of the whole business. A gate that keeps out
 * fraud but also keeps out a legitimate entrant has not made the platform safer — it has made
 * the free route less real, which is the failure that matters.
 *
 * So the rules below refuse only what can be refused without narrowing the entry:
 *
 *   - A CLOSED, SUSPENDED or SELF_EXCLUDED account. Not a barrier to entry — these players
 *     have either left or been stopped, and pushing free coins at a self-excluded player is
 *     the inducement the status exists to prevent. Zone 1 refuses this too, under the wallet
 *     lock; this is the pre-flight.
 *   - A prohibited jurisdiction. Offering an entry where the sweepstakes is not offered is
 *     the offence, not a workaround for it.
 *   - A period already claimed. The frequency cap, and the only rule here aimed at abuse.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY KYC IS NOT REQUIRED BY DEFAULT — AND WHERE THE ANTI-FRAUD ACTUALLY LIVES
 * ─────────────────────────────────────────────────────────────────────────────
 * The obvious objection to an open free route is multi-accounting: the per-user period cap is
 * trivially defeated by making more users, and identity verification is the natural answer.
 *
 * Requiring verified identity to obtain a FREE entry is a real barrier to the statutory route,
 * and it is the wrong place to put the control, because the control already exists one step
 * later. AMOE Sweeps Coins land in SC_UNPLAYED and are subject to the same 1x playthrough as
 * purchased ones, and redemption — the only path from coins to money — already requires
 * VERIFIED. A multi-accounter can therefore farm SC_UNPLAYED across accounts and cannot cash
 * any of it out without passing KYC on every one of them, which is exactly where duplicate
 * identities are caught.
 *
 * The identity barrier belongs at the cash-out, where it is already enforced and where it
 * costs a fraudster everything, rather than at the free entry, where it costs a legitimate
 * entrant their statutory route and costs the fraudster nothing they cannot re-create.
 *
 * `requireVerifiedKyc` exists so an operator whose counsel disagrees can turn it on as a data
 * change. It defaults OFF, and the default is the argued position above.
 *
 * REJECTED KYC is refused regardless of that switch. That is not a verification barrier — it
 * is an account the operator has already declined, and it is the same rule every other path
 * applies.
 */

/** How often one person may claim a free entry. */
export type AmoeGrantPeriod = "DAY" | "WEEK" | "MONTH";

/** Every distinct reason a claim can be refused. One member per rule, so nothing aggregates. */
export type AmoeRefusal =
  | "JURISDICTION_BLOCKED"
  | "PLAYER_NOT_ACTIVE"
  | "KYC_REJECTED"
  | "KYC_REQUIRED"
  | "PERIOD_ALREADY_CLAIMED";

export interface AmoePolicy {
  /** Jurisdictions where the sweepstakes is not offered, so no entry may be issued. */
  readonly closedJurisdictions: readonly string[];
  /** Off by default — see the note above before turning it on. */
  readonly requireVerifiedKyc: boolean;
}

/** The facts a claim is judged on. Gathered by the caller; this module asks for nothing. */
export interface AmoeFacts {
  /** Resolved jurisdiction, or "" when it could not be determined. */
  jurisdiction: string;
  /** The player's local KYC status. */
  kycStatus: string;
  /** The player's lifecycle status as ZONE 1 reports it. Advisory; the engine re-checks. */
  playerStatus: string;
  /** Whether this player already holds a grant for the period being claimed. */
  periodAlreadyClaimed: boolean;
}

export type AmoeDecision = { allowed: true } | { allowed: false; refusals: AmoeRefusal[] };

// ── Individual predicates, each answering exactly one question ─────────────────

/**
 * A jurisdiction is open unless it is named closed.
 *
 * An UNKNOWN jurisdiction ("") is treated as open here, and that is deliberate: the
 * geo-fence at the perimeter is the control that refuses unresolvable locations, and
 * duplicating a fail-closed geo decision in a policy module would mean a geo outage silently
 * became an AMOE outage — closing the statutory free route for a reason that has nothing to
 * do with the player.
 */
export function jurisdictionAllowsAmoe(jurisdiction: string, policy: AmoePolicy): boolean {
  if (jurisdiction === "") return true;
  return !policy.closedJurisdictions.includes(jurisdiction);
}

/** Strictly ACTIVE. A blocked player is not offered new coins — see the header. */
export function playerStatusAllowsAmoe(playerStatus: string): boolean {
  return playerStatus === "ACTIVE";
}

/**
 * REJECTED is always refused. VERIFIED always passes. PENDING passes unless the operator has
 * turned `requireVerifiedKyc` on.
 */
export function kycAllowsAmoe(kycStatus: string, policy: AmoePolicy): boolean {
  if (kycStatus === "REJECTED") return false;
  if (!policy.requireVerifiedKyc) return true;
  return kycStatus === "VERIFIED";
}

/** The frequency cap's predicate. The DATABASE is what actually enforces it — see below. */
export function periodIsAvailable(periodAlreadyClaimed: boolean): boolean {
  return !periodAlreadyClaimed;
}

/**
 * Apply every rule and return ALL refusals rather than the first.
 *
 * All of them, because a caller who fixes one reason and is then refused for another has been
 * given a worse experience than a caller told both at once — and on the free route, which a
 * regulator may test by hand, "it kept refusing me for a new reason each time" is a finding.
 */
export function evaluateAmoeClaim(facts: AmoeFacts, policy: AmoePolicy): AmoeDecision {
  const refusals: AmoeRefusal[] = [];

  if (!jurisdictionAllowsAmoe(facts.jurisdiction, policy)) refusals.push("JURISDICTION_BLOCKED");
  if (!playerStatusAllowsAmoe(facts.playerStatus)) refusals.push("PLAYER_NOT_ACTIVE");
  if (facts.kycStatus === "REJECTED") {
    refusals.push("KYC_REJECTED");
  } else if (!kycAllowsAmoe(facts.kycStatus, policy)) {
    refusals.push("KYC_REQUIRED");
  }
  if (!periodIsAvailable(facts.periodAlreadyClaimed)) refusals.push("PERIOD_ALREADY_CLAIMED");

  return refusals.length === 0 ? { allowed: true } : { allowed: false, refusals };
}

// ── The period key ────────────────────────────────────────────────────────────

/**
 * The canonical key for the period an instant falls in, e.g. `DAY:2026-09-18`.
 *
 * ALWAYS UTC. A period boundary that followed the player's own timezone would hand an extra
 * claim to anyone willing to change it, and "change your clock for a second free entry" is not
 * an attack that needs any skill.
 *
 * The granularity is part of the key. `DAY:2026-09-18` and `MONTH:2026-09` can never collide,
 * so changing the configured period cannot make a new claim look like an old one. The
 * trade-off — a player who claimed under the old granularity may claim once more under the
 * new — is a policy change taking effect rather than a defect, and is documented on the
 * column so it is a decision and not a surprise.
 *
 * All arithmetic here is on integer date components. There is no float, and no
 * milliseconds-per-day division, which is the usual way a "which week is it" helper goes
 * wrong across a DST boundary — a hazard UTC removes but the idiom would reintroduce.
 */
export function amoePeriodKey(now: Date, period: AmoeGrantPeriod): string {
  const year = now.getUTCFullYear();
  switch (period) {
    case "DAY":
      return `DAY:${year}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
    case "WEEK": {
      const { isoYear, isoWeek } = isoWeekOf(now);
      return `WEEK:${isoYear}-W${pad2(isoWeek)}`;
    }
    case "MONTH":
      return `MONTH:${year}-${pad2(now.getUTCMonth() + 1)}`;
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * ISO-8601 week number and its week-numbering year.
 *
 * ISO weeks start on Monday and belong to the year containing their Thursday, which is why
 * 1 January can fall in week 52 of the previous year. Computed the standard way: shift to
 * that week's Thursday, then count weeks from 1 January of the Thursday's year.
 *
 * Both endpoints are normalized to midnight UTC, so their millisecond difference is an exact
 * multiple of 86,400,000 and the division is exact; the `Math.round` is a guard, not a
 * correction. (This is calendar arithmetic, not money — the float ban governs financial
 * values, which never appear in this function.)
 *
 * The week-numbering YEAR is returned alongside the week, not assumed to be the calendar
 * year: without it, `WEEK:2027-W01` and `WEEK:2026-W01` would be indistinguishable for a
 * 1 January that belongs to the previous ISO year, and one player would get two free entries
 * in one week every few years. This is the kind of defect that surfaces once a year in
 * production and never in a test that uses today's date.
 */
function isoWeekOf(date: Date): { isoYear: number; isoWeek: number } {
  // Midnight UTC of the given day, so the arithmetic below is in whole days.
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const target = new Date(day);
  // getUTCDay(): Sunday = 0. Shift so Monday = 0 … Sunday = 6, then step to this week's
  // Thursday, which is the day that decides the week's year.
  const mondayBased = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - mondayBased + 3);

  const isoYear = target.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const daysSinceJan1 = Math.round((target.getTime() - jan1.getTime()) / 86_400_000);
  const isoWeek = Math.floor(daysSinceJan1 / 7) + 1;

  return { isoYear, isoWeek };
}
