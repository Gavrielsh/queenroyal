import { ApiError, apiClient, isMoneyString, type RequestOptions } from "@/lib/apiClient";
import type { DailyBonusClaim, DailyBonusStatus, StreakDay, WheelSegment } from "@/lib/meta/types";

/**
 * Live client for the Daily Wheel (gateway: GET /api/bonus/daily, POST /api/bonus/daily/claim).
 *
 * Both responses are runtime-validated into lib/meta/types: money fields must be decimal
 * strings (never parsed), and a shape the UI does not understand is refused rather than
 * rendered half-right. The claim carries no amount — the gateway draws the slice.
 */

/** A claim that did not produce a grant, with copy that is honest about what is known. */
export class WheelClaimError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    /** True when the grant MAY have committed: the caller must retry with the SAME key. */
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = "WheelClaimError";
  }
}

const STREAK_ICONS = new Set<StreakDay["icon"]>(["coin", "sc", "wheel", "chest"]);
const STREAK_STATES = new Set<StreakDay["state"]>(["claimed", "today", "upcoming"]);

function malformed(field: string): ApiError {
  return new ApiError(0, "MALFORMED_DAILY_BONUS", `Daily wheel response failed validation at ${field}`);
}

function dataOf(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) throw malformed("(root)");
  const envelope = payload as Record<string, unknown>;
  if (envelope.success !== true) throw malformed("success");
  if (typeof envelope.data !== "object" || envelope.data === null) throw malformed("data");
  return envelope.data as Record<string, unknown>;
}

export function parseDailyBonusStatus(payload: unknown): DailyBonusStatus {
  const data = dataOf(payload);

  if (!Array.isArray(data.segments) || data.segments.length < 2) throw malformed("data.segments");
  const segments: WheelSegment[] = data.segments.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== "string" || s.id === "") throw malformed(`data.segments[${i}].id`);
    if (!isMoneyString(s.gc)) throw malformed(`data.segments[${i}].gc`);
    if (!isMoneyString(s.sc)) throw malformed(`data.segments[${i}].sc`);
    const weight = s.weight;
    if (weight !== undefined && (typeof weight !== "number" || !Number.isInteger(weight) || weight <= 0)) {
      throw malformed(`data.segments[${i}].weight`);
    }
    return { id: s.id, gc: s.gc, sc: s.sc, featured: s.featured === true, ...(weight ? { weight } : {}) };
  });

  if (!Array.isArray(data.streak)) throw malformed("data.streak");
  const streak: StreakDay[] = data.streak.map((raw, i) => {
    const d = raw as Record<string, unknown>;
    if (typeof d.day !== "number" || typeof d.label !== "string") throw malformed(`data.streak[${i}]`);
    if (!STREAK_ICONS.has(d.icon as StreakDay["icon"])) throw malformed(`data.streak[${i}].icon`);
    if (!STREAK_STATES.has(d.state as StreakDay["state"])) throw malformed(`data.streak[${i}].state`);
    return { day: d.day, label: d.label, icon: d.icon as StreakDay["icon"], state: d.state as StreakDay["state"] };
  });

  if (typeof data.streakDay !== "number") throw malformed("data.streakDay");
  if (typeof data.canClaim !== "boolean") throw malformed("data.canClaim");
  if (data.nextClaimAt !== null && typeof data.nextClaimAt !== "string") throw malformed("data.nextClaimAt");

  return {
    segments,
    streak,
    streakDay: data.streakDay,
    canClaim: data.canClaim,
    nextClaimAt: data.nextClaimAt as string | null,
  };
}

export function parseDailyBonusClaim(payload: unknown): DailyBonusClaim {
  const data = dataOf(payload);
  if (data.status !== "GRANTED") throw malformed("data.status");
  if (typeof data.segmentId !== "string" || data.segmentId === "") throw malformed("data.segmentId");
  if (!isMoneyString(data.gcAmount)) throw malformed("data.gcAmount");
  if (!isMoneyString(data.scAmount)) throw malformed("data.scAmount");
  return { segmentId: data.segmentId, gc: data.gcAmount, sc: data.scAmount };
}

export async function fetchDailyBonusStatus(opts?: RequestOptions): Promise<DailyBonusStatus> {
  return parseDailyBonusStatus(await apiClient.get<unknown>("/bonus/daily", opts));
}

/**
 * Claim today's spin. `idempotencyKey` must be stable across retries of ONE attempt, so a
 * response lost in transit replays the original grant instead of being refused.
 */
export async function claimDailyBonus(idempotencyKey: string): Promise<DailyBonusClaim> {
  try {
    return parseDailyBonusClaim(await apiClient.post<unknown>("/bonus/daily/claim", { idempotencyKey }));
  } catch (err) {
    throw toWheelClaimError(err);
  }
}

/** Player-facing copy per failure. It never says "nothing happened" when that is not known. */
export function toWheelClaimError(err: unknown): WheelClaimError {
  const code = err instanceof ApiError ? (err.code ?? null) : null;
  const status = err instanceof ApiError ? err.status : 0;
  switch (code) {
    case "ALREADY_CLAIMED_TODAY":
    case "ATTEMPT_FAILED":
      return new WheelClaimError("Today's spin is already used — come back tomorrow.", code);
    case "KYC_REJECTED":
    case "PLAYER_NOT_ACTIVE":
      return new WheelClaimError("This account can't receive promotional coins.", code);
    case "RATE_LIMITED":
      return new WheelClaimError("Too many attempts — please wait a moment and try again.", code);
    case "JURISDICTION_BLOCKED":
    case "GEO_BLOCKED":
      return new WheelClaimError("The Daily Wheel isn't offered in your location.", code);
  }
  // Timeouts, 5xx, in-flight and network faults: the grant MAY have committed.
  if (code === "ATTEMPT_IN_FLIGHT" || status === 0 || status >= 500) {
    return new WheelClaimError(
      "We couldn't confirm your spin. If it went through, the prize will appear in your balance shortly.",
      code,
      true,
    );
  }
  return new WheelClaimError("The wheel could not be spun right now. Please try again shortly.", code);
}
