import { Prisma, type RedemptionRequest } from "@prisma/client";

import { getRedemptionCaps } from "../config/redemption-caps";
import type { FlowContext } from "../lib/context";
import { runInTransaction } from "../lib/db/transaction";
import type { AuthClaims } from "../lib/jwt";
import { childLogger } from "../lib/logger";
import { compareMoney, sumMoney } from "../lib/money";
import { getPrisma } from "../lib/prisma";
import { enqueueReconcile } from "../lib/reconcile-queue";
import {
  type RedemptionFacts,
  type RedemptionRefusal,
  evaluateRedemption,
} from "../lib/redemption-policy";
import { trueEngine } from "../lib/true-engine";
import type { RedeemInput } from "../schemas/redeem.schema";
import type { RedeemPayload, TrueEngineErrorBody } from "../types/true-engine";
import { beginEngineRequest, completeEngineRequest } from "./engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "./player-provisioning.service";

/**
 * Money OUT, orchestrated — and orchestrated ONLY.
 *
 * The shape deliberately mirrors `purchasePackage`: resolve the identity bridge, gate, take
 * the attempt anchor, journal the intent, and only then touch Zone 1. The one structural
 * difference is where settlement happens. A purchase cannot settle at request time because a
 * card has to be confirmed first, so it journals and waits for a webhook. A redemption's SC
 * debit has nothing to wait for: it commits synchronously at the engine, in this request, and
 * the payout that follows is a separate lifecycle on the RedemptionRequest row.
 *
 * ZERO FINANCIAL STATE. This service never computes a balance, never reads one, and never
 * stores one. It does not ask whether the player can afford the redemption — the engine
 * answers that by refusing the debit. `post_balances` comes back on the engine's response and
 * is deliberately NOT persisted: the moment Zone 2 keeps a post-debit figure it owns a second
 * copy of the truth, and a second copy is a reconciliation bug waiting for its first
 * disagreement.
 *
 * The amounts this service does handle — the request amount and the period sums — are decimal
 * strings throughout, added with `sumMoney` (exact integer units). There is no float here.
 */

export interface RedemptionAccepted {
  status: "UNDER_REVIEW";
  redemptionId: string;
  operatorTransactionId: string;
  ledgerTransactionId: string;
  amount: string;
}

export type RedemptionOutcome =
  | { ok: true; data: RedemptionAccepted }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * Statuses whose amounts COUNT against the period caps.
 *
 * Everything that took, or still intends to take, the player's SC. REJECTED and
 * CANCELLED_BY_PLAYER are excluded because no money moved for them — counting a refused
 * request against a cap would punish a player for an operator's decision.
 */
export const CAP_COUNTING_STATUSES = ["REQUESTED", "UNDER_REVIEW", "APPROVED", "PROCESSING", "PAID"] as const;

const ATTEMPT_EXHAUSTED: TrueEngineErrorBody = {
  code: "ATTEMPT_EXHAUSTED",
  message: "This redemption attempt can no longer be completed; start a new one",
};

/** Engine refusal codes that mean the same thing as one of the policy's own refusals. */
const ENGINE_REFUSAL_TO_POLICY: Readonly<Record<string, RedemptionRefusal>> = {
  PLAYER_NOT_ACTIVE: "PLAYER_NOT_ACTIVE",
  PLAYTHROUGH_OUTSTANDING: "PLAYTHROUGH_OUTSTANDING",
};

/**
 * Facts the policy needs that ZONE 1 OWNS.
 *
 * These are now read from `POST /api/v1/session`, which reports the player's lifecycle status
 * and outstanding playthrough alongside the balances — one consistent snapshot, so the two
 * cannot disagree with each other.
 *
 * They are ADVISORY and the gate they feed is a PRE-FLIGHT one. The engine re-checks both
 * under the wallet lock and is still the authority; refusing here only avoids spending a
 * signed round trip on a request already known to be doomed, and an engine refusal is mapped
 * back onto the same vocabulary so the contract is identical whichever layer said no.
 *
 * Still injectable, because a test that has to stand up an engine to exercise a policy gate is
 * a test nobody runs.
 */
export interface EngineOwnedFacts {
  playerStatus: string;
  playthroughOutstanding: string;
}

export interface RedemptionDeps {
  /** Returns the Zone-1-owned facts, or null when they cannot be known here. */
  engineOwnedFacts?: (playerId: string) => Promise<EngineOwnedFacts | null>;
  /**
   * The clock the cap PERIODS are measured against. Injectable because "today" and "this
   * month" are the whole substance of the period rules, and a test that cannot say when it is
   * cannot test them — it can only wait for the calendar to disagree with it.
   */
  now?: () => Date;
}

export async function requestRedemption(
  user: AuthClaims,
  input: RedeemInput,
  ctx: FlowContext = {},
  deps: RedemptionDeps = {},
): Promise<RedemptionOutcome> {
  const flowLog = childLogger({ trace_id: ctx.traceId, user_id: user.sub });

  // 1) Identity bridge + current KYC status (single DB read; lazy provisioning) — as purchase.
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

  const playerId = player.trueEnginePlayerId;
  const attemptId = input.idempotencyKey;
  const operatorTransactionId = `redeem:${attemptId}`;

  // 2) Attempt-anchor gate, fail closed, BEFORE any engine call — the purchase flow's gate,
  //    unchanged in substance. The journal row is the durable authority on who owns this
  //    attempt and where it is in its lifecycle, which makes a redemption single-owner and
  //    single-shot: a leaked token cannot drive a debit on another player's wallet, and a
  //    settled attempt cannot be replayed into a second payout.
  const existing = await getPrisma().engineRequestLog.findUnique({ where: { operatorTransactionId } });
  if (existing) {
    if (existing.playerId !== playerId) {
      // Uniform refusal; nothing is revealed about the foreign attempt and the token value
      // itself is never logged.
      flowLog.warn({ journal_status: existing.status }, "redemption rejected: attempt anchor owned by another player");
      return {
        ok: false,
        status: 409,
        error: { code: "ATTEMPT_OWNERSHIP", message: "This redemption attempt cannot be used by this account" },
      };
    }
    if (existing.status === "SUCCEEDED") {
      return {
        ok: false,
        status: 409,
        error: { code: "ATTEMPT_SETTLED", message: "This redemption attempt has already settled; start a new one" },
      };
    }
    if (existing.status === "ABANDONED" || existing.status === "COMPENSATED") {
      return { ok: false, status: 409, error: ATTEMPT_EXHAUSTED };
    }
    // PENDING / FAILED → the owner retrying an in-flight attempt: fall through. The engine
    // de-duplicates on the same anchor, so the retry reaches the original debit.
  }

  // 3) Policy gates (B3). Pure predicates over facts gathered here; the module itself decides
  //    nothing about where a fact came from. The Zone-1 facts are a network read, so they are
  //    fetched BEFORE the per-player lock below and never hold it open across a round trip.
  const jurisdiction = ctx.jurisdiction ?? "";
  const readFacts = deps.engineOwnedFacts ?? fetchEngineOwnedFacts;
  const engineFacts = await readFacts(playerId);
  const now = deps.now ? deps.now() : new Date();

  // 3+4) Gate and record under ONE per-player lock. The period caps are a check-then-act over
  //    this player's rows, and the engine does not enforce them, so two concurrent attempts
  //    must not both read the same "redeemed today" and both insert. The advisory lock
  //    serialises them; READ COMMITTED (not SERIALIZABLE) so the sum, taken AFTER the lock is
  //    granted, sees the row the previous holder committed — a serializable snapshot would be
  //    pinned at the lock statement and miss it.
  //
  //    The orchestration row is created BEFORE the debit so a crash between the two leaves a
  //    REQUESTED row naming the anchor — an operator can see what was attempted. A debit with
  //    no row would be money moved with no record of why. A retry of an in-flight attempt
  //    reuses that row rather than inserting a second one under the same unique anchor.
  const gate = await runInTransaction(
    async (tx): Promise<{ ok: true; redemption: RedemptionRequest } | { ok: false; outcome: RedemptionOutcome }> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`redeem:${playerId}`}, 0))`;

      const prior = await tx.redemptionRequest.findUnique({ where: { operatorTransactionId } });
      if (prior && prior.status !== "REQUESTED") {
        // The attempt already reached a terminal decision (e.g. REJECTED by the engine).
        return { ok: false, outcome: { ok: false, status: 409, error: ATTEMPT_EXHAUSTED } };
      }
      if (prior && compareMoney(prior.amount, input.amount) !== 0) {
        // The engine de-duplicates on the anchor, so a changed amount would silently debit the
        // ORIGINAL figure while the player believes they asked for this one.
        return {
          ok: false,
          outcome: {
            ok: false,
            status: 409,
            error: { code: "ATTEMPT_MISMATCH", message: "This redemption attempt was started with a different amount" },
          },
        };
      }

      const periods = await sumRedeemedPeriods(tx, playerId, now, operatorTransactionId);
      const facts: RedemptionFacts = {
        jurisdiction,
        kycStatus: player.kycStatus,
        // A null here means the snapshot call itself failed, NOT that the player is clear. The
        // values fall back to the neutral element for their gates and the engine — which
        // refuses under the wallet lock regardless — decides; its refusal is mapped at step 6.
        // Failing the whole request on an advisory read would turn a degraded optimisation
        // into an outage.
        playerStatus: engineFacts?.playerStatus ?? "ACTIVE",
        playthroughOutstanding: engineFacts?.playthroughOutstanding ?? "0",
        amount: input.amount,
        redeemedToday: periods.today,
        redeemedThisMonth: periods.thisMonth,
      };

      const decision = evaluateRedemption(facts, getRedemptionCaps());
      if (!decision.allowed) {
        flowLog.warn(
          { refusals: decision.refusals, jurisdiction, gates_deferred_to_engine: engineFacts === null },
          "redemption refused by policy",
        );
        return {
          ok: false,
          outcome: { ok: false, status: refusalStatus(decision.refusals[0]), error: refusalError(decision.refusals) },
        };
      }

      const redemption =
        prior ??
        (await tx.redemptionRequest.create({
          data: {
            userId: player.userId,
            playerId,
            status: "REQUESTED",
            amount: input.amount,
            operatorTransactionId,
          },
        }));
      return { ok: true, redemption };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  if (!gate.ok) return gate.outcome;
  const redemption = gate.redemption;

  // 5) Journal the intent, then call. Same order as every other money path: the durable
  //    record exists before the network does.
  const payload: RedeemPayload = {
    operator_transaction_id: operatorTransactionId,
    player_id: playerId,
    amount: input.amount,
    metadata: { redemption_id: redemption.id, jurisdiction },
  };
  await beginEngineRequest({
    operatorTransactionId,
    type: "REDEEM",
    playerId,
    providerRef: redemption.id,
    requestPayload: payload,
  });

  const res = await trueEngine().sendRedeem(payload);

  // 6) Failure: record it, hand a retryable one to the reconciler (which now knows how to
  //    replay a REDEEM), and map an engine refusal onto the policy's own vocabulary so the
  //    caller cannot tell — and does not need to — which layer refused.
  if (!res.ok) {
    await completeEngineRequest(operatorTransactionId, "FAILED", {
      retryable: res.retryable,
      lastError: `${res.error.code}: ${res.error.message}`,
    });
    if (res.retryable) {
      await enqueueReconcile({ operatorTransactionId, reason: "redeem_failed_retryable" });
      // Left at REQUESTED on purpose: the debit may well have committed at the engine without
      // us seeing the response, and marking it REJECTED would assert an outcome we do not
      // know. The reconciler resolves it.
    } else {
      await getPrisma().redemptionRequest.update({
        where: { id: redemption.id },
        data: {
          status: "REJECTED",
          statusChangedAt: new Date(),
          decisionReason: `engine refused: ${res.error.code}`,
          reviewedAt: new Date(),
          reviewedBy: "SYSTEM",
        },
      });
    }
    const mapped = ENGINE_REFUSAL_TO_POLICY[res.error.code];
    flowLog.warn(
      { operator_transaction_id: operatorTransactionId, engine_status: res.status, err_code: res.error.code },
      "redemption debit refused by the engine",
    );
    return {
      ok: false,
      status: res.status === 0 ? 502 : res.status,
      error: mapped ? { ...res.error, details: { refusals: [mapped] } } : res.error,
    };
  }

  // 7) Settled. The SC is debited in Zone 1 and the request moves to review.
  //
  //    `res.data.post_balances` is available here and is deliberately dropped. Persisting it
  //    would give Zone 2 a balance, which is the one thing it may never hold.
  await completeEngineRequest(operatorTransactionId, "SUCCEEDED", {
    ledgerTransactionId: res.data.ledger_transaction_id,
  });
  await getPrisma().redemptionRequest.update({
    where: { id: redemption.id },
    data: {
      status: "UNDER_REVIEW",
      statusChangedAt: new Date(),
      ledgerTransactionId: res.data.ledger_transaction_id,
    },
  });

  flowLog.info(
    {
      operator_transaction_id: operatorTransactionId,
      redemption_id: redemption.id,
      ledger_transaction_id: res.data.ledger_transaction_id,
    },
    "redemption debited and queued for review",
  );

  return {
    ok: true,
    data: {
      status: "UNDER_REVIEW",
      redemptionId: redemption.id,
      operatorTransactionId,
      ledgerTransactionId: res.data.ledger_transaction_id,
      amount: input.amount,
    },
  };
}

/**
 * Sum what this player has already redeemed in the current UTC day and month.
 *
 * Summed in application code with `sumMoney` rather than in SQL, because `amount` is a TEXT
 * column by design (B1) and SUM() over text is not a thing Postgres will do — which is the
 * float ban holding the line one layer further down than usual.
 *
 * UTC boundaries: the cap period has to be the same instant for every player and every
 * reviewer, and a local-timezone day would silently give players in one region a longer day
 * than another.
 */
async function sumRedeemedPeriods(
  tx: Prisma.TransactionClient,
  playerId: string,
  now: Date,
  excludeOperatorTransactionId: string,
): Promise<{ today: string; thisMonth: string }> {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const rows = await tx.redemptionRequest.findMany({
    where: {
      playerId,
      status: { in: [...CAP_COUNTING_STATUSES] },
      createdAt: { gte: startOfMonth },
    },
    select: { amount: true, createdAt: true, operatorTransactionId: true },
  });

  // A retry's own earlier row is the request being evaluated, not prior history: counting it
  // would refuse the retry for consuming its own headroom.
  const counted = rows.filter((r) => r.operatorTransactionId !== excludeOperatorTransactionId);
  const monthAmounts = counted.map((r) => r.amount);
  const dayAmounts = counted.filter((r) => r.createdAt >= startOfDay).map((r) => r.amount);
  return {
    today: dayAmounts.length > 0 ? sumMoney(...dayAmounts) : "0",
    thisMonth: monthAmounts.length > 0 ? sumMoney(...monthAmounts) : "0",
  };
}

/** HTTP status for a refusal. 403 = "not you / not now"; 422 = "not this amount". */
function refusalStatus(primary: RedemptionRefusal): number {
  switch (primary) {
    case "JURISDICTION_NOT_PERMITTED":
    case "KYC_NOT_VERIFIED":
    case "PLAYER_NOT_ACTIVE":
    case "PLAYTHROUGH_OUTSTANDING":
      return 403;
    default:
      return 422;
  }
}

/** One stable code (the most significant refusal) plus the full list for support tooling. */
function refusalError(refusals: readonly RedemptionRefusal[]): TrueEngineErrorBody {
  return {
    code: refusals[0] ?? "REDEMPTION_REFUSED",
    message: "This redemption cannot be processed",
    details: { refusals: [...refusals] },
  };
}

/**
 * Default source for the Zone-1-owned facts: the engine's own session snapshot.
 *
 * Returns null rather than throwing when the read fails. This is a pre-flight optimisation, and
 * an engine hiccup on an advisory read must not fail a redemption the engine would have
 * accepted — the authoritative gates still run inside the debit.
 */
async function fetchEngineOwnedFacts(playerId: string): Promise<EngineOwnedFacts | null> {
  const res = await trueEngine().getBalances({ player_id: playerId });
  if (!res.ok) return null;
  return {
    playerStatus: res.data.status,
    playthroughOutstanding: res.data.playthrough_outstanding,
  };
}
