/**
 * Client-side mirror of the gateway's sign-up rules (apps/financial-gateway/src/lib/
 * registration-policy.ts), for instant feedback only. The gateway re-checks everything.
 */

export const MIN_AGE = 18;

/** Completed years on `now`'s UTC calendar date; null for a missing or impossible date. */
export function ageOn(dateOfBirth: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  let age = now.getUTCFullYear() - year;
  const [nowMonth, nowDay] = [now.getUTCMonth() + 1, now.getUTCDate()];
  if (nowMonth < month || (nowMonth === month && nowDay < day)) age -= 1;
  return age;
}

/** The latest date of birth that is 18 today, as `YYYY-MM-DD` (the date picker's `max`). */
export function latestEligibleBirthDate(now: Date): string {
  const y = now.getUTCFullYear() - MIN_AGE;
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  // 29 Feb minus 18 years does not exist; the day before is the latest safe date.
  return ageOn(`${y}-${mm}-${dd}`, now) === null ? `${y}-02-28` : `${y}-${mm}-${dd}`;
}
