import { randomUUID } from "node:crypto";

import { getDailyBonusOffer, type WheelSlice } from "../config/daily-bonus";
import type { FlowContext } from "../lib/context";
import { drawSlice, gamingDateKey, nextResetAt, streakLength } from "../lib/daily-bonus-policy";
import type { AuthClaims } from "../lib/jwt";
import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import { enqueueReconcile } from "../lib/reconcile-queue";
import { trueEngine } from "../lib/true-engine";
import type { DailyBonusClaimInput } from "../schemas/daily-bonus.schema";
import type { PromoGrantPayload, TrueEngineErrorBody } from "../types/true-engine";
import { beginEngineRequest, completeEngineRequest } from "./engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "./player-provisioning.service";

/**
 * The Daily Wheel: one server-drawn spin per player per gaming day, credited through the
 * engine's promo-grant endpoint on the BONUS channel.
 *
 * It is the AMOE flow (amoe.service.ts) with a different cap key and a server-side draw, and it
 * keeps that flow's order of operations for the same reason — the Zone 1 endpoint is uncapped:
 *
 *   1. Resolve identity.
 *   2. Replay a repeated attempt token with its ORIGINAL outcome.
 *   3. Pre-flight: has today already been consumed? (advisory — fast, friendly answer)
 *   4. Draw the slice on the server (CSPRNG, configured weights).
 *   5. TAKE THE DAY — insert the row; `@@unique([userId, gamingDate])` is the real cap.
 *   6. Journal the intent, then call Zone 1.
 *
 * A failed dispatch keeps the day spent (see amoe.service.ts: releasing it turns a reliably
 * failing condition into an unbounded retry loop at an unbounded endpoint). A RETRYABLE failure
 * leaves the row REQUESTED for the reconciler, which replays the journaled PROMO_GRANT through
 * the engine's idempotency — it can resolve the grant, never issue a second one.
 *
 * Zero financial state: amounts come from config and are forwarded verbatim as strings; the
 * engine's post_balances are dropped. The browser re-reads its wallet from the ledger.
 */

export interface DailyBonusGranted {
  status: "GRANTED";
  claimId: string;
  gamingDate: string;
  segmentId: string;
  gcAmount: string;
  scAmount: string;
  ledgerTransactionId: string;
  nextClaimAt: string;
}

export type DailyBonusOutcome =
  | { ok: true; data: DailyBonusGranted }
  | { ok: false; status: number; error: TrueEngineErrorBody };

export interface DailyBonusStatusView {
  segments: Array<{ id: string; gc: string; sc: string; weight: number; featured: boolean }>;
  totalWeight: number;
  streak: Array<{ day: number; label: string; icon: "wheel"; state: "claimed" | "today" | "upcoming" }>;
  streakDay: number;
  canClaim: boolean;
  nextClaimAt: string | null;
  gamingDate: string;
  timeZone: string;
}

export interface DailyBonusDeps {
  /** The clock the gaming day is measured against. Injectable: the day boundary IS the cap. */
  now?: () => Date;
  /** The draw's random source; production uses node:crypto randomInt. */
  pick?: (max: number) => number;
}

const STREAK_CYCLE = 7;
/** How far back the status read looks for streak days. Longer streaks display as the cycle. */
const STREAK_LOOKBACK_DAYS = 60;

const ENGINE_REFUSAL_CODES = new Set(["PLAYER_NOT_ACTIVE", "GEO_BLOCKED"]);

function segmentsView(slices: readonly WheelSlice[]): DailyBonusStatusView["segments"] {
  return slices.map((s) => ({ id: s.id, gc: s.gcAmount, sc: s.scAmount, weight: s.weight, featured: s.featured ?? false }));
}

/** GET /api/bonus/daily — the wheel, the odds, today's availability and the streak ladder. */
export async function getDailyBonusStatus(user: AuthClaims, deps: DailyBonusDeps = {}): Promise<DailyBonusStatusView> {
  const offer = getDailyBonusOffer();
  const now = deps.now ? deps.now() : new Date();
  const today = gamingDateKey(now, offer.timeZone);

  const since = new Date(now.getTime() - STREAK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await getPrisma().dailyBonusClaim.findMany({
    where: { userId: user.sub, createdAt: { gte: since } },
    select: { gamingDate: true },
  });
  // Every row consumed its day — REQUESTED and FAILED included (the cap does not release).
  const days = rows.map((r: { gamingDate: string }) => r.gamingDate);
  const claimedToday = days.includes(today);
  const current = streakLength(days, today);

  // Position of the latest slot in the 7-day ladder.
  const streakDay = claimedToday ? current : current + 1;
  const slot = ((streakDay - 1) % STREAK_CYCLE) + 1;
  const streak = Array.from({ length: STREAK_CYCLE }, (_, i) => {
    const day = i + 1;
    const state: "claimed" | "today" | "upcoming" =
      day < slot || (day === slot && claimedToday) ? "claimed" : day === slot ? "today" : "upcoming";
    return { day, label: "Wheel", icon: "wheel" as const, state };
  });

  return {
    segments: segmentsView(offer.slices),
    totalWeight: offer.slices.reduce((sum, s) => sum + s.weight, 0),
    streak,
    streakDay,
    canClaim: !claimedToday,
    nextClaimAt: claimedToday ? nextResetAt(now, offer.timeZone).toISOString() : null,
    gamingDate: today,
    timeZone: offer.timeZone,
  };
}

/** POST /api/bonus/daily/claim — draw, take the day, credit through Zone 1. */
export async function claimDailyBonus(
  user: AuthClaims,
  input: DailyBonusClaimInput,
  ctx: FlowContext = {},
  deps: DailyBonusDeps = {},
): Promise<DailyBonusOutcome> {
  const flowLog = childLogger({ trace_id: ctx.traceId, user_id: user.sub });
  const offer = getDailyBonusOffer();
  const now = deps.now ? deps.now() : new Date();
  const gamingDate = gamingDateKey(now, offer.timeZone);
  const nextClaimAt = nextResetAt(now, offer.timeZone).toISOString();

  // 1) Identity bridge (lazy provisioning), as every money path.
  let player;
  try {
    player = await resolveTransactingPlayer(user.sub);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned in the ledger", details: err.message },
      };
    }
    throw err;
  }

  // 2) Attempt replay BEFORE any gate: a retry deserves its original answer.
  const prior = await getPrisma().dailyBonusClaim.findUnique({
    where: { userId_claimAttemptKey: { userId: player.userId, claimAttemptKey: input.idempotencyKey } },
  });
  if (prior) return replayAttempt(prior, nextClaimAt);

  // 3) Pre-flight (advisory; step 5 is the cap).
  if (player.kycStatus === "REJECTED") {
    return {
      ok: false,
      status: 403,
      error: { code: "KYC_REJECTED", message: "This account cannot receive promotional coins" },
    };
  }
  const existing = await getPrisma().dailyBonusClaim.findUnique({
    where: { userId_gamingDate: { userId: player.userId, gamingDate } },
  });
  if (existing) return alreadyClaimed(gamingDate, nextClaimAt);

  // 4) The draw. Server-side, CSPRNG, configured weights — the client never names a slice.
  const slice = drawSlice(offer.slices, deps.pick);

  // 5) TAKE THE DAY. A P2002 is the cap working (a repeat, or the losing half of a race).
  const claimId = randomUUID();
  const operatorTransactionId = `bonus:daily:${claimId}`;
  const channelReference = `BONUS-${claimId}`;
  try {
    await getPrisma().dailyBonusClaim.create({
      data: {
        id: claimId,
        userId: player.userId,
        playerId: player.trueEnginePlayerId,
        gamingDate,
        segmentId: slice.id,
        status: "REQUESTED",
        gcAmount: slice.gcAmount,
        scAmount: slice.scAmount,
        operatorTransactionId,
        channelReference,
        claimAttemptKey: input.idempotencyKey,
        claimIp: ctx.ip ?? null,
        claimJurisdiction: ctx.jurisdiction ?? null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      flowLog.warn({ gaming_date: gamingDate }, "daily bonus refused by a unique constraint");
      return alreadyClaimed(gamingDate, nextClaimAt);
    }
    throw err;
  }

  // 6) Journal, then call.
  const payload: PromoGrantPayload = {
    operator_transaction_id: operatorTransactionId,
    player_id: player.trueEnginePlayerId,
    gc_amount: slice.gcAmount,
    sc_amount: slice.scAmount,
    channel: "BONUS",
    channel_reference: channelReference,
    metadata: { daily_bonus_claim_id: claimId, gaming_date: gamingDate, segment_id: slice.id },
  };
  await beginEngineRequest({
    operatorTransactionId,
    type: "PROMO_GRANT",
    playerId: player.trueEnginePlayerId,
    providerRef: claimId,
    requestPayload: payload,
  });

  const res = await trueEngine().sendPromoGrant(payload);

  if (!res.ok) {
    await completeEngineRequest(operatorTransactionId, "FAILED", {
      retryable: res.retryable,
      lastError: `${res.error.code}: ${res.error.message}`,
    });
    if (res.retryable) {
      await enqueueReconcile({ operatorTransactionId, reason: "promo_grant_failed_retryable" });
    } else {
      await getPrisma().dailyBonusClaim.update({
        where: { id: claimId },
        data: { status: "FAILED", failureReason: `engine refused: ${res.error.code}` },
      });
    }
    flowLog.warn(
      { operator_transaction_id: operatorTransactionId, engine_status: res.status, err_code: res.error.code },
      "daily bonus grant refused by the engine",
    );
    const status = res.status === 0 ? 502 : ENGINE_REFUSAL_CODES.has(res.error.code) ? 403 : res.status;
    return { ok: false, status, error: res.error };
  }

  // 7) Granted. post_balances is deliberately dropped (Zone 2 holds no balances).
  await completeEngineRequest(operatorTransactionId, "SUCCEEDED", {
    ledgerTransactionId: res.data.ledger_transaction_id,
  });
  await getPrisma().dailyBonusClaim.update({
    where: { id: claimId },
    data: { status: "GRANTED", ledgerTransactionId: res.data.ledger_transaction_id },
  });
  flowLog.info(
    {
      operator_transaction_id: operatorTransactionId,
      daily_bonus_claim_id: claimId,
      gaming_date: gamingDate,
      segment_id: slice.id,
      ledger_transaction_id: res.data.ledger_transaction_id,
    },
    "daily bonus granted",
  );

  return {
    ok: true,
    data: {
      status: "GRANTED",
      claimId,
      gamingDate,
      segmentId: slice.id,
      gcAmount: slice.gcAmount,
      scAmount: slice.scAmount,
      ledgerTransactionId: res.data.ledger_transaction_id,
      nextClaimAt,
    },
  };
}

function alreadyClaimed(gamingDate: string, nextClaimAt: string): DailyBonusOutcome {
  // 409, not 429: waiting a few seconds will not help — the day is spent until it rolls over.
  return {
    ok: false,
    status: 409,
    error: {
      code: "ALREADY_CLAIMED_TODAY",
      message: "Today's Daily Wheel spin has already been used",
      details: { gamingDate, nextClaimAt },
    },
  };
}

function replayAttempt(
  row: {
    id: string;
    status: string;
    gamingDate: string;
    segmentId: string;
    gcAmount: string;
    scAmount: string;
    ledgerTransactionId: string | null;
    failureReason: string | null;
  },
  nextClaimAt: string,
): DailyBonusOutcome {
  if (row.status === "GRANTED" && row.ledgerTransactionId) {
    return {
      ok: true,
      data: {
        status: "GRANTED",
        claimId: row.id,
        gamingDate: row.gamingDate,
        segmentId: row.segmentId,
        gcAmount: row.gcAmount,
        scAmount: row.scAmount,
        ledgerTransactionId: row.ledgerTransactionId,
        nextClaimAt,
      },
    };
  }
  if (row.status === "FAILED") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "ATTEMPT_FAILED",
        message: "This spin already failed; today's spin is spent",
        details: { gamingDate: row.gamingDate, reason: row.failureReason },
      },
    };
  }
  return {
    ok: false,
    status: 409,
    error: {
      code: "ATTEMPT_IN_FLIGHT",
      message: "This spin is still being settled; check back shortly",
      details: { gamingDate: row.gamingDate },
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

