import { getRedemptionCaps } from "../config/redemption-caps";
import { subtractMoneyFloor0, sumMoney } from "../lib/money";
import { getPrisma } from "../lib/prisma";
import { capsFor } from "../lib/redemption-policy";
import { CAP_COUNTING_STATUSES } from "./redemption.service";

/**
 * Read-only view of a player's redemption activity — deliberately separate from
 * redemption.service.ts, which owns the money-moving write path.
 *
 * NEVER PROVISIONS, NEVER CALLS THE ENGINE. `resolveTransactingPlayer` (the write path's
 * identity bridge) lazily provisions an engine player as a side effect, which is exactly
 * wrong for a page view — a player who has never redeemed anything should be able to look at
 * this screen without silently creating engine state. So this module scopes every query by
 * `User.id` (`RedemptionRequest.userId`), never by the engine's `playerId`, and reads KYC and
 * residence straight off the `users` row instead of resolving a `TransactingPlayer`.
 *
 * The displayed caps and remaining-this-period figures are ADVISORY: `POST /store/redeem`
 * (redemption.service.ts, keyed by `playerId`) re-derives its own facts at request time and
 * is the only authority on whether an amount is actually accepted.
 */

const HISTORY_LIMIT = 50;

export interface RedemptionHistoryEntry {
  id: string;
  amount: string;
  status: string;
  createdAt: string;
  statusChangedAt: string;
}

export type RedemptionPolicyView =
  | {
      jurisdictionPermitted: true;
      minimumAmount: string;
      maximumPerRequest: string;
      dailyCap: string;
      monthlyCap: string;
      remainingToday: string;
      remainingThisMonth: string;
    }
  | { jurisdictionPermitted: false };

export interface RedemptionOverview {
  /** Sourced from the `users` row, never from a JWT claim — KYC can change mid-session. */
  kycStatus: string;
  /** Newest first, capped at {@link HISTORY_LIMIT}. */
  requests: RedemptionHistoryEntry[];
  policy: RedemptionPolicyView;
}

/**
 * Sum this player's non-rejected redemptions in the current UTC day and month — the same
 * CAP_COUNTING_STATUSES and UTC-boundary rule redemption.service.ts uses, scoped by `userId`
 * instead of the engine `playerId` (see module doc). Added with `sumMoney`: exact integer
 * units, never a float.
 */
async function sumRedeemedPeriods(userId: string, now: Date): Promise<{ today: string; thisMonth: string }> {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const rows = await getPrisma().redemptionRequest.findMany({
    where: {
      userId,
      status: { in: [...CAP_COUNTING_STATUSES] },
      createdAt: { gte: startOfMonth },
    },
    select: { amount: true, createdAt: true },
  });

  const monthAmounts = rows.map((r) => r.amount);
  const dayAmounts = rows.filter((r) => r.createdAt >= startOfDay).map((r) => r.amount);
  return {
    today: dayAmounts.length > 0 ? sumMoney(...dayAmounts) : "0",
    thisMonth: monthAmounts.length > 0 ? sumMoney(...monthAmounts) : "0",
  };
}

export async function getRedemptionOverview(userId: string, now: Date = new Date()): Promise<RedemptionOverview> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { kycStatus: true, residenceState: true },
  });
  if (!user) throw new Error(`getRedemptionOverview: unknown user ${userId}`);

  const rows = await prisma.redemptionRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  const requests: RedemptionHistoryEntry[] = rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    statusChangedAt: r.statusChangedAt.toISOString(),
  }));

  const table = getRedemptionCaps();
  // The cap table's jurisdiction keys are "US-<state>" (redemption-caps.ts); an unset
  // residenceState (registration predates the field, or a not-yet-backfilled row) falls back
  // to the default table rather than being treated as a closed jurisdiction.
  const jurisdiction = user.residenceState ? `US-${user.residenceState}` : null;
  const caps = jurisdiction ? capsFor(table, jurisdiction) : table.default;

  if (!caps) {
    return { kycStatus: user.kycStatus, requests, policy: { jurisdictionPermitted: false } };
  }

  const { today, thisMonth } = await sumRedeemedPeriods(userId, now);
  return {
    kycStatus: user.kycStatus,
    requests,
    policy: {
      jurisdictionPermitted: true,
      minimumAmount: caps.minimumAmount,
      maximumPerRequest: caps.maximumPerRequest,
      dailyCap: caps.dailyCap,
      monthlyCap: caps.monthlyCap,
      remainingToday: subtractMoneyFloor0(caps.dailyCap, today),
      remainingThisMonth: subtractMoneyFloor0(caps.monthlyCap, thisMonth),
    },
  };
}
