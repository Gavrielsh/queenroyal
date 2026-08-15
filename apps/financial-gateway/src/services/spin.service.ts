import type { FlowContext } from "../lib/context";
import { assertKycAllows, KycGateError } from "../lib/kyc-policy";
import { childLogger } from "../lib/logger";
import { enqueueReconcile } from "../lib/reconcile-queue";
import { trueEngine } from "../lib/true-engine";
import type { AuthClaims } from "../lib/jwt";
import type { SpinInput } from "../schemas/spin.schema";
import type { EngineSpinResult, SpinPayload, TrueEngineErrorBody } from "../types/true-engine";
import { beginEngineRequest, completeEngineRequest } from "./engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "./player-provisioning.service";

export type SpinOutcomeResult =
  | { ok: true; data: EngineSpinResult }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * Player-initiated, SERVER-AUTHORITATIVE spin.
 *
 * The gateway's job here is deliberately small — it is an authenticated, KYC-gated,
 * idempotency-journalled pass-through. It does NOT compute or influence the outcome:
 *
 *   1. Resolve OUR user id → engine player_id (+ current KYC status).
 *   2. Server-side KYC gate (never trust the JWT claim, which may be stale).
 *   3. Journal the intent under a deterministic key derived from the client's attempt token.
 *   4. Forward ONLY the stake, currency, and game to the engine.
 *
 * The engine draws the reels, evaluates the paytable, derives the payout, and settles the
 * debit and credit in ONE transaction under ONE wallet lock. Because both legs are atomic
 * there is no "bet committed but win failed" state to compensate — the failure mode that
 * `game-adapter.service` still has to handle for third-party provider spins simply cannot
 * occur here.
 */
export async function processPlayerSpin(
  user: AuthClaims,
  input: SpinInput,
  ctx: FlowContext = {},
): Promise<SpinOutcomeResult> {
  const flowLog = childLogger({
    trace_id: ctx.traceId,
    user_id: user.sub,
    game_id: input.gameId,
    currency: input.currency,
  });

  // 1) Identity bridge + current KYC status (single DB read, lazy provisioning).
  let player;
  try {
    player = await resolveTransactingPlayer(user.sub);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      flowLog.warn({ err }, "spin rejected: player not provisioned");
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned in the ledger" },
      };
    }
    throw err;
  }

  // 2) Server-side KYC gate. SC play is real-money-adjacent, so the gate is currency-aware.
  try {
    assertKycAllows(player.kycStatus, "SPIN", input.currency);
  } catch (err) {
    if (err instanceof KycGateError) {
      flowLog.warn({ kyc_status: player.kycStatus, err_code: err.code }, "spin rejected: KYC gate");
      return { ok: false, status: 403, error: { code: err.code, message: err.message } };
    }
    throw err;
  }

  const playerId = player.trueEnginePlayerId;
  const operatorTransactionId = `spin:${input.idempotencyKey}`;

  // Ownership gate on the attempt anchor: an attempt token belongs to exactly one player, so
  // a leaked or guessed token can never be used to drive a spin on someone else's wallet.
  const existing = await findSpinIntent(operatorTransactionId);
  if (existing && existing.playerId && existing.playerId !== playerId) {
    flowLog.warn("spin rejected: attempt anchor owned by another player");
    return {
      ok: false,
      status: 409,
      error: { code: "ATTEMPT_OWNERSHIP", message: "This spin attempt cannot be used by this account" },
    };
  }

  // 3) Journal the intent BEFORE the call so a crash mid-flight is recoverable. The payload
  //    carries no win amount — there is nothing here for a replay to inflate.
  const payload: SpinPayload = {
    operator_transaction_id: operatorTransactionId,
    player_id: playerId,
    currency: input.currency,
    bet_amount: input.betAmount,
    ...(input.gameId ? { game_id: input.gameId } : {}),
  };
  await beginEngineRequest({
    operatorTransactionId,
    type: "BET",
    playerId,
    requestPayload: payload,
  });

  // 4) Forward. The engine owns the outcome from here.
  const res = await trueEngine().sendSpin(payload);
  if (!res.ok) {
    await completeEngineRequest(operatorTransactionId, "FAILED", {
      retryable: res.retryable,
      lastError: `${res.error.code}: ${res.error.message}`,
    });
    // A retryable failure (timeout, 409, 5xx) may have committed at the engine without us
    // seeing the response. Hand it to the reconciler for an idempotent replay under the same
    // key — which ghost-recovers the ORIGINAL outcome rather than drawing a new one.
    if (res.retryable) {
      await enqueueReconcile({ operatorTransactionId, reason: "spin_failed_retryable" });
    }
    flowLog.warn(
      { operator_transaction_id: operatorTransactionId, engine_status: res.status, err_code: res.error.code },
      "spin failed",
    );
    return { ok: false, status: res.status === 0 ? 502 : res.status, error: res.error };
  }

  await completeEngineRequest(operatorTransactionId, "SUCCEEDED", {
    ledgerTransactionId: res.data.bet_ledger_transaction_id,
  });
  flowLog.info(
    {
      operator_transaction_id: operatorTransactionId,
      line: res.data.outcome.line,
      status: res.data.status,
    },
    "spin settled",
  );
  return { ok: true, data: res.data };
}

/** Look up an existing spin intent by its anchor. Separate for test seams. */
async function findSpinIntent(operatorTransactionId: string) {
  const { getPrisma } = await import("../lib/prisma");
  return getPrisma().engineRequestLog.findUnique({ where: { operatorTransactionId } });
}
