/**
 * Who may open an account. Enforced at registration, the first point a player tells us who and
 * where they are; the per-request geo fence (lib/geo.ts) still guards every money route.
 *
 *   - AGE: 18 or older on the server's UTC calendar date. The date of birth is DECLARED here and
 *     proven later by KYC (the provider's verified DOB is the one redemption trusts).
 *   - RESIDENCE: a US state or DC that is not in BLOCKED_REGIONS. The same list the IP fence uses,
 *     so "we don't serve Washington" means the same thing at sign-up and at play time.
 *   - TERMS: the player accepted the current Terms of Service and Official Sweepstakes Rules.
 *     The version they accepted is stored with the timestamp, so a later revision can require
 *     re-acceptance.
 *
 * Minimum ages and excluded states are defaults, not legal advice — review with counsel.
 */

export const MIN_REGISTRATION_AGE = 18;

/**
 * Version of the Terms of Service + Official Sweepstakes Rules a new account accepts. Bump it
 * (as the publication date) whenever either document changes materially.
 */
export const TERMS_VERSION = "2026-09-23";

/** The 50 states plus DC, as USPS codes. */
export const US_STATES: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
]);

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a `YYYY-MM-DD` calendar date. Null for a malformed key or an impossible date (02-30). */
export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const m = DATE_KEY.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** Completed years between a date of birth and `now`'s UTC calendar date. */
export function ageOn(dateOfBirth: string, now: Date): number | null {
  const dob = parseDateKey(dateOfBirth);
  if (!dob) return null;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  let age = year - dob.year;
  if (month < dob.month || (month === dob.month && day < dob.day)) age -= 1;
  return age;
}

/** A US state (or DC) that the platform serves under the configured blocklist. */
export function isEligibleResidence(state: string, blockedRegions: readonly string[]): boolean {
  const code = state.trim().toUpperCase();
  if (!US_STATES.has(code)) return false;
  return !blockedRegions.some((r) => r.trim().toUpperCase() === `US-${code}`);
}
