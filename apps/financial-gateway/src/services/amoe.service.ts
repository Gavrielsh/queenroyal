import { randomUUID } from "node:crypto";

import { getAmoeOffer, getAmoePolicy } from "../config/amoe";
import { type AmoeFacts, type AmoeRefusal, amoePeriodKey, evaluateAmoeClaim } from "../lib/amoe-policy";
import type { FlowContext } from "../lib/context";
import type { AuthClaims } from "../lib/jwt";
import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import { enqueueReconcile } from "../lib/reconcile-queue";
import { trueEngine } from "../lib/true-engine";
import type { AmoeClaimInput } from "../schemas/amoe.schema";
import type { PromoGrantPayload, TrueEngineErrorBody } from "../types/true-engine";
import { beginEngineRequest, completeEngineRequest } from "./engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "./player-provisioning.service";

/**
 * The free entry, orchestrated — and orchestrated ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SERVICE IS ACTUALLY FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * The Zone 1 endpoint it dispatches to is deliberately unbounded: the ledger issues what an
 * authenticated operator asks it to, because its job is to record movements correctly rather
 * than to decide who deserves one. Everything standing between the public internet and
 * unlimited free coin issuance is in this file and the unique index it relies on.
 *
 * The order of operations is therefore not cosmetic, and it is the one thing to preserve if
 * this is ever refactored:
 *
 *   1. Resolve identity.
 *   2. Read the claimed period's state and run the policy gate (pre-flight).
 *   3. TAKE THE PERIOD — insert the AmoeGrant row, whose unique index is the cap.
 *   4. Journal the intent.
 *   5. Only then call Zone 1.
 *
 * Step 3 before step 5 is what makes the cap real. Two concurrent claims both pass step 2 —
 * each reads before the other writes — and exactly one survives step 3, because Postgres
 * refuses the second INSERT regardless of how the requests interleave. Had the engine call
 * come first, both would have been granted and the row would merely have recorded the fact.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A FAILED DISPATCH STILL CONSUMES THE PERIOD
 * ─────────────────────────────────────────────────────────────────────────────
 * The row is kept, marked FAILED, when the engine refuses or cannot be reached. Releasing the
 * period on failure looks kinder and is the more dangerous choice: it turns any reliably
 * failing condition into an unbounded retry loop pointed at an unbounded ledger endpoint, and
 * an attacker who can cause failures can then claim without limit. Keeping it means an
 * operator re-grants manually for the rare genuine failure — a support cost, bounded and
 * visible, instead of an issuance hole.
 *
 * A RETRYABLE failure is different in kind and is treated differently: the credit may well
 * have committed at the engine without us seeing the response, so the row stays REQUESTED and
 * the reconciler resolves it. Marking that FAILED would assert an outcome we do not know.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZERO FINANCIAL STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * This service never computes a balance, never reads one, and never stores one. The engine's
 * response carries `post_balances` and it is deliberately dropped: the moment Zone 2 keeps a
 * post-grant figure it owns a second copy of the truth.
 *
 * The amounts it does handle come from config and are forwarded verbatim as decimal strings.
 * There is no arithmetic on them anywhere in this file — not even addition — so there is no
 * float, and nothing to round.
 */

export interface AmoeGranted {
  status: "GRANTED";
  grantId: string;
  grantPeriod: string;
  operatorTransactionId: string;
  ledgerTransactionId: string;
  scAmount: string;
  gcAmount: string;
}

export type AmoeOutcome =
  | { ok: true; data: AmoeGranted }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/** Engine refusal codes that mean the same thing as one of the policy's own refusals. */
const ENGINE_REFUSAL_TO_POLICY: Readonly<Record<string, AmoeRefusal>> = {
  PLAYER_NOT_ACTIVE: "PLAYER_NOT_ACTIVE",
  GEO_BLOCKED: "JURISDICTION_BLOCKED",
};

export interface AmoeDeps {
  /**
   * The player's lifecycle status as Zone 1 reports it, or null when it cannot be known here.
   *
   * ADVISORY, exactly as in the redemption flow: the engine re-checks under the wallet lock
   * and is the authority. Refusing here only avoids spending a signed round trip — and, more
   * importantly on this route, avoids consuming a period on a claim already known to be
   * doomed. Injectable because a test that must stand up an engine to exercise a policy gate
   * is a test nobody runs.
   */
  playerStatus?: (playerId: string) => Promise<string | null>;
  /**
   * The clock the PERIOD is measured against. Injectable because the period boundary is the
   * whole substance of the frequency cap, and a test that cannot say when it is cannot test it
   * — it can only wait for the calendar to disagree.
   */
  now?: () => Date;
}

export async function claimAmoeGrant(
  user: AuthClaims,
  input: AmoeClaimInput,
  ctx: FlowContext = {},
  deps: AmoeDeps = {},
): Promise<AmoeOutcome> {
  const flowLog = childLogger({ trace_id: ctx.traceId, user_id: user.sub });
  const offer = getAmoeOffer();
  const now = deps.now ? deps.now() : new Date();
  const grantPeriod = amoePeriodKey(now, offer.period);

  // 1) Identity bridge + current KYC status (single DB read; lazy provisioning) — as every
  //    other money path.
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

  // 2) ATTEMPT REPLAY, before any gate. A client that submitted a claim and never saw the
  //    response deserves its ORIGINAL outcome on retry — not "the period is already claimed",
  //    which it has no way to tell apart from genuine abuse. Keyed per user, so two strangers
  //    choosing the same token cannot read or block each other's claim.
  const priorAttempt = await getPrisma().amoeGrant.findUnique({
    where: { userId_claimAttemptKey: { userId: player.userId, claimAttemptKey: input.idempotencyKey } },
  });
  if (priorAttempt) {
    return replayAttempt(priorAttempt);
  }

  // 3) Pre-flight. The period read here is ADVISORY — it answers fast and with a useful
  //    message for the overwhelmingly common honest case, but it is NOT the cap. Two
  //    concurrent claims both pass this. Step 4 is where one of them loses.
  const existing = await getPrisma().amoeGrant.findUnique({
    where: { userId_grantPeriod: { userId: player.userId, grantPeriod } },
  });

  const readStatus = deps.playerStatus ?? fetchPlayerStatus;
  const engineStatus = await readStatus(player.trueEnginePlayerId);

  const facts: AmoeFacts = {
    jurisdiction: ctx.jurisdiction ?? "",
    kycStatus: player.kycStatus,
    // A null means the snapshot call failed, NOT that the player is blocked. It falls back to
    // the permissive value and the engine — which refuses under the wallet lock regardless —
    // decides. Failing the statutory free route closed because an advisory read was
    // unavailable would turn a degraded optimisation into a compliance outage.
    playerStatus: engineStatus ?? "ACTIVE",
    periodAlreadyClaimed: existing !== null,
  };

  const decision = evaluateAmoeClaim(facts, getAmoePolicy());
  if (!decision.allowed) {
    flowLog.warn(
      { refusals: decision.refusals, grant_period: grantPeriod, status_deferred_to_engine: engineStatus === null },
      "amoe claim refused by policy",
    );
    return { ok: false, status: refusalStatus(decision.refusals[0]), error: refusalError(decision.refusals, grantPeriod) };
  }

  // 4) TAKE THE PERIOD. This INSERT is the frequency cap — everything above is advice.
  //
  //    A P2002 here is not an error condition; it is the cap doing its job, either against a
  //    genuine repeat claim or against the losing half of a race. Reported as the same clean
  //    refusal the pre-flight would have given, so a claimant cannot tell the two apart and
  //    does not need to.
  //
  //    The id is minted HERE rather than by the database, so the anchor and the channel
  //    reference — both derived from it — are known before the row exists and the whole thing
  //    is one write. An insert-then-update would leave a window in which a crash stranded a
  //    row carrying a placeholder anchor and no journal entry.
  const grantId = randomUUID();
  const operatorTransactionId = `amoe:${grantId}`;
  const channelReference = `AMOE-${grantId}`;

  let grant;
  try {
    grant = await getPrisma().amoeGrant.create({
      data: {
        id: grantId,
        userId: player.userId,
        playerId: player.trueEnginePlayerId,
        grantPeriod,
        status: "REQUESTED",
        scAmount: offer.scAmount,
        gcAmount: offer.gcAmount,
        operatorTransactionId,
        channelReference,
        claimAttemptKey: input.idempotencyKey,
        claimIp: ctx.ip ?? null,
        claimJurisdiction: ctx.jurisdiction ?? null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Either unique can land here. Both mean the same thing to the caller — this claim is
      // not getting a second grant — and the period is the one worth naming.
      flowLog.warn({ grant_period: grantPeriod }, "amoe claim refused by a unique constraint");
      return {
        ok: false,
        status: 409,
        error: refusalError(["PERIOD_ALREADY_CLAIMED"], grantPeriod),
      };
    }
    throw err;
  }

  // 5) Journal the intent, then call. Same order as every other money path: the durable
  //    record exists before the network does.
  const payload: PromoGrantPayload = {
    operator_transaction_id: operatorTransactionId,
    player_id: player.trueEnginePlayerId,
    sc_amount: offer.scAmount,
    gc_amount: offer.gcAmount,
    channel: "AMOE",
    channel_reference: channelReference,
    metadata: { amoe_grant_id: grant.id, grant_period: grantPeriod, jurisdiction: ctx.jurisdiction ?? "" },
  };
  await beginEngineRequest({
    operatorTransactionId,
    type: "PROMO_GRANT",
    playerId: player.trueEnginePlayerId,
    providerRef: grant.id,
    requestPayload: payload,
  });

  const res = await trueEngine().sendPromoGrant(payload);

  // 6) Failure. A retryable one leaves the row REQUESTED for the reconciler — the credit may
  //    have committed without us seeing the response. A terminal one is recorded as FAILED,
  //    and the period stays spent: see the header for why releasing it would be worse.
  if (!res.ok) {
    await completeEngineRequest(operatorTransactionId, "FAILED", {
      retryable: res.retryable,
      lastError: `${res.error.code}: ${res.error.message}`,
    });
    if (res.retryable) {
      await enqueueReconcile({ operatorTransactionId, reason: "promo_grant_failed_retryable" });
    } else {
      await getPrisma().amoeGrant.update({
        where: { id: grant.id },
        data: { status: "FAILED", failureReason: `engine refused: ${res.error.code}` },
      });
    }
    const mapped = ENGINE_REFUSAL_TO_POLICY[res.error.code];
    flowLog.warn(
      { operator_transaction_id: operatorTransactionId, engine_status: res.status, err_code: res.error.code },
      "amoe grant refused by the engine",
    );
    return {
      ok: false,
      status: res.status === 0 ? 502 : res.status,
      error: mapped ? { ...res.error, details: { refusals: [mapped] } } : res.error,
    };
  }

  // 7) Granted. The coins are credited in Zone 1.
  //
  //    `res.data.post_balances` is available here and is deliberately dropped. Persisting it
  //    would give Zone 2 a balance, which is the one thing it may never hold.
  await completeEngineRequest(operatorTransactionId, "SUCCEEDED", {
    ledgerTransactionId: res.data.ledger_transaction_id,
  });
  await getPrisma().amoeGrant.update({
    where: { id: grant.id },
    data: { status: "GRANTED", ledgerTransactionId: res.data.ledger_transaction_id },
  });

  flowLog.info(
    {
      operator_transaction_id: operatorTransactionId,
      amoe_grant_id: grant.id,
      grant_period: grantPeriod,
      ledger_transaction_id: res.data.ledger_transaction_id,
    },
    "amoe grant issued",
  );

  return {
    ok: true,
    data: {
      status: "GRANTED",
      grantId: grant.id,
      grantPeriod,
      operatorTransactionId,
      ledgerTransactionId: res.data.ledger_transaction_id,
      scAmount: offer.scAmount,
      gcAmount: offer.gcAmount,
    },
  };
}

/** The player's lifecycle status from Zone 1's session snapshot. Advisory — see AmoeDeps. */
async function fetchPlayerStatus(playerId: string): Promise<string | null> {
  const res = await trueEngine().getBalances({ player_id: playerId });
  if (!res.ok) return null;
  return res.data.status ?? null;
}

/**
 * Prisma's unique-constraint violation, recognised without importing the Prisma runtime error
 * class — which the test fake does not construct and which would couple this service to a
 * generated namespace for one string comparison.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Answer a repeat of an attempt token with the outcome the first attempt reached.
 *
 * GRANTED replays the original success verbatim, so a client that lost the response ends up
 * with the same grant id and ledger transaction it would have had. FAILED replays the refusal.
 * REQUESTED means the first attempt is still unresolved — it either crashed mid-flight or
 * failed retryably and is with the reconciler — and the honest answer is "not yet", never a
 * second dispatch: the credit may already have committed at the engine.
 */
function replayAttempt(row: {
  id: string;
  status: string;
  grantPeriod: string;
  operatorTransactionId: string;
  ledgerTransactionId: string | null;
  scAmount: string;
  gcAmount: string;
  failureReason: string | null;
}): AmoeOutcome {
  if (row.status === "GRANTED" && row.ledgerTransactionId) {
    return {
      ok: true,
      data: {
        status: "GRANTED",
        grantId: row.id,
        grantPeriod: row.grantPeriod,
        operatorTransactionId: row.operatorTransactionId,
        ledgerTransactionId: row.ledgerTransactionId,
        scAmount: row.scAmount,
        gcAmount: row.gcAmount,
      },
    };
  }
  if (row.status === "FAILED") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "ATTEMPT_FAILED",
        message: "This free-entry attempt already failed; the period it used is spent",
        details: { grantPeriod: row.grantPeriod, reason: row.failureReason },
      },
    };
  }
  return {
    ok: false,
    status: 409,
    error: {
      code: "ATTEMPT_IN_FLIGHT",
      message: "This free-entry attempt is still being resolved; check back shortly",
      details: { grantPeriod: row.grantPeriod },
    },
  };
}

/**
 * HTTP status per refusal.
 *
 * PERIOD_ALREADY_CLAIMED is 409, not 429: the claimant is not being throttled and slowing
 * down will not help them — the period is spent and the answer will be the same until it
 * rolls over. A 429 would invite exactly the retry loop this route must not reward.
 */
function refusalStatus(refusal: AmoeRefusal | undefined): number {
  if (refusal === undefined) return 403;
  switch (refusal) {
    case "JURISDICTION_BLOCKED":
      return 403;
    case "PLAYER_NOT_ACTIVE":
    case "KYC_REJECTED":
    case "KYC_REQUIRED":
      return 403;
    case "PERIOD_ALREADY_CLAIMED":
      return 409;
  }
}

/**
 * The refusal body.
 *
 * It names the period and every refusal, because this is the statutory free route: a player
 * — or a regulator testing it by hand — who is told only "no" cannot tell a working
 * once-per-day cap from a broken entry method, and the second is a finding.
 */
function refusalError(refusals: AmoeRefusal[], grantPeriod: string): TrueEngineErrorBody {
  // evaluateAmoeClaim only returns `allowed: false` with a non-empty list, and the explicit
  // literal call site below passes one. The fallback exists so a future caller cannot turn an
  // empty array into an undefined error code on the wire.
  const primary: AmoeRefusal = refusals[0] ?? "PLAYER_NOT_ACTIVE";
  return {
    code: primary,
    message: refusalMessage(primary),
    details: { refusals, grantPeriod },
  };
}

function refusalMessage(refusal: AmoeRefusal): string {
  switch (refusal) {
    case "JURISDICTION_BLOCKED":
      return "Free entries are not offered in your jurisdiction";
    case "PLAYER_NOT_ACTIVE":
      return "This account cannot receive a free entry while it is closed, suspended, or self-excluded";
    case "KYC_REJECTED":
      return "This account cannot receive a free entry";
    case "KYC_REQUIRED":
      return "Identity verification is required before a free entry can be issued";
    case "PERIOD_ALREADY_CLAIMED":
      return "A free entry has already been issued for this period";
  }
}
