import { randomInt } from "node:crypto";

import type { WheelSlice } from "../config/daily-bonus";

/**
 * Pure rules for the Daily Wheel: which gaming day it is, which slice the server draws, and how
 * long the player's streak is. No I/O, so each rule is tested on its own.
 */

/**
 * The gaming day for `now` in `timeZone`, as "YYYY-MM-DD". Server clock only: a day boundary
 * that followed the client's clock would hand an extra spin to anyone willing to change it.
 */
export function gamingDateKey(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The calendar day before `key` ("2026-03-01" → "2026-02-28"). Pure date arithmetic, no zone. */
export function previousDateKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * The next local midnight after `now` in `timeZone` — when the next spin opens.
 *
 * Found by stepping forward in 15-minute increments until the gaming day changes, which is
 * correct across DST transitions (where "now + 24h" is not) and cheap (at most 100 steps).
 */
export function nextResetAt(now: Date, timeZone: string): Date {
  const today = gamingDateKey(now, timeZone);
  const step = 15 * 60 * 1000;
  let t = Math.floor(now.getTime() / step) * step + step;
  while (gamingDateKey(new Date(t), timeZone) === today) t += step;
  // Refine to the minute inside the last step.
  let lo = t - step;
  while (t - lo > 60 * 1000) {
    const mid = lo + Math.floor((t - lo) / 2);
    if (gamingDateKey(new Date(mid), timeZone) === today) lo = mid;
    else t = mid;
  }
  return new Date(Math.ceil(t / 60000) * 60000);
}

/**
 * Weighted draw over the configured slices with a CSPRNG. `pick` is injectable for tests; in
 * production it is node:crypto's randomInt, which is uniform over [0, max).
 */
export function drawSlice(
  slices: readonly WheelSlice[],
  pick: (max: number) => number = (max) => randomInt(max),
): WheelSlice {
  const total = slices.reduce((sum, s) => sum + s.weight, 0);
  let roll = pick(total);
  for (const slice of slices) {
    if (roll < slice.weight) return slice;
    roll -= slice.weight;
  }
  // Unreachable for a pick in [0, total); guarded so a bad injected pick cannot return nothing.
  const last = slices[slices.length - 1];
  if (!last) throw new Error("daily bonus: no slices configured");
  return last;
}

/**
 * Consecutive-day streak ending today (if claimed) or yesterday (if today is still open).
 * `claimedDays` are the gaming days that already consumed a spin, in any order.
 */
export function streakLength(claimedDays: Iterable<string>, today: string): number {
  const days = new Set(claimedDays);
  let cursor = days.has(today) ? today : previousDateKey(today);
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = previousDateKey(cursor);
  }
  return n;
}
