import type { FlowContext } from "../lib/context";
import { assertKycAllows, KycGateError } from "../lib/kyc-policy";
import { childLogger } from "../lib/logger";
import { isPositiveMoneyString } from "../lib/money";
import { getPrisma } from "../lib/prisma";
import { enqueueReconcile } from "../lib/reconcile-queue";
import { trueEngine } from "../lib/true-engine";
import type { ProviderRollbackInput, ProviderSpinInput } from "../schemas/game.schema";
import type {
  BetPayload,
  Currency,
  EngineBalances,
  EngineTxResult,
  RollbackPayload,
  TrueEngineErrorBody,
  WinPayload,
} from "../types/true-engine";
import { beginEngineRequest, completeEngineRequest } from "./engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "./player-provisioning.service";

export interface SpinSuccess {
  providerTransactionId: string;
  roundId: string | undefined;
  currency: Currency;
  bet: EngineTxResult;
  win: EngineTxResult | null;
  balances: EngineBalances;
}

export type SpinOutcome =
  | { ok: true; data: SpinSuccess }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * B2B game-aggregator adapter. The inbound webhook has ALREADY been HMAC/timestamp/nonce
 * verified by the route — this function trusts the provider, not the player.
 *
 *   1. Resolve OUR user id → engine player_id (+ current KYC status), provisioning lazily.
 *   2. Server-side KYC gate (never trust a stale JWT claim — this path has no JWT anyway).
 *   3. Derive STABLE, deterministic idempotency keys from the provider's txn id
 *      (`bet:<id>` / `win:<id>`) and journal the exact payloads for replay/compensation.
 *   4. sendBet → on success, sendWin (when win > 0) referencing the bet's
 *      `ledger_transaction_id`.
 */
export async function processProviderSpin(
  providerCode: string,
  input: ProviderSpinInput,
  ctx: FlowContext = {},
): Promise<SpinOutcome> {
  const engine = trueEngine();
  const flowLog = childLogger({
    trace_id: ctx.traceId,
    provider: providerCode,
    user_id: input.player_id,
    provider_transaction_id: input.provider_transaction_id,
  });

  // 1) Identity bridge + current KYC status (single DB read).
  let player;
  try {
    player = await resolveTransactingPlayer(input.player_id);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      flowLog.warn({ err }, "spin rejected: player not provisioned");
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned in the ledger", details: err.message },
      };
    }
    throw err;
  }

  // 2) Server-side KYC gate.
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
  const betOpTxId = `bet:${input.provider_transaction_id}`;
  const winOpTxId = `win:${input.provider_transaction_id}`;
  const metadata = { provider: providerCode };

  // 3) Debit the bet first.
  const betPayload: BetPayload = {
    operator_transaction_id: betOpTxId,
    player_id: playerId,
    currency: input.currency,
    amount: input.bet_amount,
    game_id: input.game_id,
    round_id: input.round_id,
    metadata,
  };
  await beginEngineRequest({
    operatorTransactionId: betOpTxId,
    type: "BET",
    playerId,
    providerRef: input.provider_transaction_id,
    requestPayload: betPayload,
  });
  const bet = await engine.sendBet(betPayload);
  if (!bet.ok) {
    await completeEngineRequest(betOpTxId, "FAILED", {
      retryable: bet.retryable,
      lastError: `${bet.error.code}: ${bet.error.message}`,
    });
    // A retryable failure (e.g. a ghost spin: committed but the 200 was lost) hands the
    // intent to the event-driven reconciler for an idempotent replay under the same key.
    if (bet.retryable) await enqueueReconcile({ operatorTransactionId: betOpTxId, reason: "bet_failed_retryable" });
    flowLog.warn(
      { operator_transaction_id: betOpTxId, engine_status: bet.status, err_code: bet.error.code, retryable: bet.retryable },
      "bet failed",
    );
    return { ok: false, status: bet.status === 0 ? 502 : bet.status, error: bet.error };
  }
  await completeEngineRequest(betOpTxId, "SUCCEEDED", { ledgerTransactionId: bet.data.ledger_transaction_id });

  // No win → return the post-bet state.
  if (!isPositiveMoneyString(input.win_amount)) {
    return {
      ok: true,
      data: {
        providerTransactionId: input.provider_transaction_id,
        roundId: input.round_id,
        currency: input.currency,
        bet: bet.data,
        win: null,
        balances: bet.data.post_balances,
      },
    };
  }

  // 4) Credit the win, linked to the bet's ledger transaction id.
  const winPayload: WinPayload = {
    operator_transaction_id: winOpTxId,
    player_id: playerId,
    currency: input.currency,
    amount: input.win_amount,
    game_id: input.game_id,
    round_id: input.round_id,
    reference_transaction_id: bet.data.ledger_transaction_id,
    metadata,
  };
  await beginEngineRequest({
    operatorTransactionId: winOpTxId,
    type: "WIN",
    playerId,
    providerRef: input.provider_transaction_id,
    requestPayload: winPayload,
  });
  const win = await engine.sendWin(winPayload);
  if (!win.ok) {
    await completeEngineRequest(winOpTxId, "FAILED", {
      retryable: win.retryable,
      lastError: `${win.error.code}: ${win.error.message}`,
    });
    flowLog.error(
      {
        operator_transaction_id: winOpTxId,
        bet_operator_transaction_id: betOpTxId,
        bet_ledger_transaction_id: bet.data.ledger_transaction_id,
        engine_status: win.status,
        err_code: win.error.code,
        retryable: win.retryable,
      },
      "win settlement failed after committed bet — handed to reconciler",
    );
    // The bet already committed. Hand the win to the reconciler, which retries it and — if
    // it is terminally rejected — compensates by rolling the bet back.
    await enqueueReconcile({ operatorTransactionId: winOpTxId, reason: "win_settlement_failed" });
    return {
      ok: false,
      status: win.status === 0 ? 502 : win.status,
      error: {
        code: "WIN_SETTLEMENT_FAILED",
        message: `Bet accepted but win settlement failed: ${win.error.message}`,
        details: {
          betOperatorTransactionId: betOpTxId,
          winOperatorTransactionId: winOpTxId,
          betLedgerTransactionId: bet.data.ledger_transaction_id,
          retryable: win.retryable,
          engine: win.error,
        },
      },
    };
  }
  await completeEngineRequest(winOpTxId, "SUCCEEDED", { ledgerTransactionId: win.data.ledger_transaction_id });
  flowLog.info(
    { bet_operator_transaction_id: betOpTxId, win_operator_transaction_id: winOpTxId },
    "spin settled (bet + win)",
  );

  return {
    ok: true,
    data: {
      providerTransactionId: input.provider_transaction_id,
      roundId: input.round_id,
      currency: input.currency,
      bet: bet.data,
      win: win.data,
      balances: win.data.post_balances,
    },
  };
}

export interface RollbackSuccess {
  providerTransactionId: string; // THIS rollback's upstream id
  referenceTransactionId: string; // the ORIGINAL bet's provider id we reversed
  /**
   * - `reversed`         — the engine reversed the committed bet on this call.
   * - `already_reversed` — the bet was already reversed (idempotent replay / a peer beat us).
   * - `noop`             — nothing was ever debited for this reference, so there is nothing to
   *   reverse. All three are an effective VOID from the provider's perspective → HTTP 200.
   */
  status: "reversed" | "already_reversed" | "noop";
  rollback: EngineTxResult | null; // the engine tx, only when we actually reversed now
  balances: EngineBalances | null;
}

export type RollbackOutcome =
  | { ok: true; data: RollbackSuccess }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * B2B game-aggregator ROLLBACK adapter. The inbound webhook has ALREADY been HMAC/timestamp/
 * nonce verified by the route. It voids a previously-placed BET when the provider's game state
 * crashes or a player disconnects catastrophically.
 *
 *   1. Resolve OUR user id → engine player_id (+ current KYC status).
 *   2. Server-side KYC gate (REJECTED hard-block only — never withhold a player's own refund).
 *   3. Resolve the ORIGINAL bet (`bet:<reference>`) to its engine `ledger_transaction_id`; the
 *      engine reverses by ledger id (a UUID it owns), which the provider does not know.
 *   4. sendRollback under the deterministic key `rollback:<reference>` — the SAME key the
 *      reconciler's win-compensation uses — so a provider rollback and an internal compensation
 *      of the same bet collapse to ONE idempotent reversal (ghost-recovered on replay).
 *
 * Idempotent-VOID semantics (the task's "stop the provider retrying" requirement): when the
 * desired end state already holds — nothing was ever debited, or the bet is already reversed —
 * we report success (HTTP 200) so the provider stops retrying, rather than 404/5xx-looping it.
 * A bet still in flight is the one case we DEFER (409, retryable) so we never no-op a debit that
 * the reconciler may still drive to a commit.
 */
export async function processProviderRollback(
  providerCode: string,
  input: ProviderRollbackInput,
  ctx: FlowContext = {},
): Promise<RollbackOutcome> {
  const engine = trueEngine();
  const ref = input.reference_transaction_id;
  const flowLog = childLogger({
    trace_id: ctx.traceId,
    provider: providerCode,
    user_id: input.player_id,
    provider_transaction_id: input.provider_transaction_id,
    reference_transaction_id: ref,
  });

  const noop = (status: RollbackSuccess["status"], rb: EngineTxResult | null): RollbackOutcome => ({
    ok: true,
    data: {
      providerTransactionId: input.provider_transaction_id,
      referenceTransactionId: ref,
      status,
      rollback: rb,
      balances: rb?.post_balances ?? null,
    },
  });

  // 1) Identity bridge + current KYC status (single DB read).
  let player;
  try {
    player = await resolveTransactingPlayer(input.player_id);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      flowLog.warn({ err }, "rollback rejected: player not provisioned");
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned in the ledger", details: err.message },
      };
    }
    throw err;
  }

  // 2) Server-side KYC gate. A rollback returns the player's OWN stake, so we enforce only the
  //    REJECTED hard-block (no SC/VERIFIED escalation): never withhold a refund from a player
  //    who was eligible to place the bet in the first place.
  try {
    assertKycAllows(player.kycStatus, "SPIN");
  } catch (err) {
    if (err instanceof KycGateError) {
      flowLog.warn({ kyc_status: player.kycStatus, err_code: err.code }, "rollback rejected: KYC gate");
      return { ok: false, status: 403, error: { code: err.code, message: err.message } };
    }
    throw err;
  }

  const playerId = player.trueEnginePlayerId;

  // 3) Resolve the original bet by its deterministic journal key.
  const betKey = `bet:${ref}`;
  const bet = await getPrisma().engineRequestLog.findUnique({ where: { operatorTransactionId: betKey } });

  // Nothing committed: the bet was never seen, or it terminally failed without debiting. There
  // is nothing to reverse → idempotent VOID no-op (200) so the provider stops retrying.
  if (!bet) {
    flowLog.info("rollback no-op: no bet journaled for reference");
    return noop("noop", null);
  }
  const committed = bet.status === "SUCCEEDED" && Boolean(bet.ledgerTransactionId);
  const inFlight =
    bet.status === "PENDING" || bet.status === "SUCCEEDED" || (bet.status === "FAILED" && bet.retryable === true);
  if (!committed) {
    if (inFlight) {
      // The bet is unresolved (ghost/in-flight; the reconciler may still commit it). We cannot
      // reverse a debit whose ledger id we don't yet know, and must NOT no-op it. Ask the
      // provider to retry shortly (retryable), by which point the bet has settled either way.
      flowLog.warn({ bet_status: bet.status }, "rollback deferred: originating bet not settled yet");
      return {
        ok: false,
        status: 409,
        error: {
          code: "BET_SETTLEMENT_PENDING",
          message: "Originating bet has not settled yet; retry the rollback shortly",
          details: { referenceTransactionId: ref, betOperatorTransactionId: betKey, betStatus: bet.status },
        },
      };
    }
    // FAILED (terminal) / ABANDONED / COMPENSATED → never debited → idempotent no-op.
    flowLog.info({ bet_status: bet.status }, "rollback no-op: originating bet never committed a debit");
    return noop("noop", null);
  }

  // Cross-player guard (defense-in-depth): refuse a rollback whose referenced bet belongs to a
  // different player than the one named in the webhook — a correlation bug must never move funds.
  if (bet.playerId && bet.playerId !== playerId) {
    flowLog.error({ bet_player_id: bet.playerId }, "rollback rejected: referenced bet belongs to another player");
    return {
      ok: false,
      status: 422,
      error: { code: "ROLLBACK_PLAYER_MISMATCH", message: "Referenced bet does not belong to this player" },
    };
  }

  // 4) Forward the reversal. Keyed off the ORIGINAL bet so it unifies with internal compensation.
  const rollbackKey = `rollback:${ref}`;
  const rollbackPayload: RollbackPayload = {
    operator_transaction_id: rollbackKey,
    player_id: playerId,
    reference_transaction_id: bet.ledgerTransactionId as string,
    metadata: { provider: providerCode, reason: "provider_rollback", provider_rollback_id: input.provider_transaction_id },
  };
  await beginEngineRequest({
    operatorTransactionId: rollbackKey,
    type: "ROLLBACK",
    playerId,
    providerRef: ref,
    requestPayload: rollbackPayload,
  });

  const rb = await engine.sendRollback(rollbackPayload);
  if (rb.ok) {
    await completeEngineRequest(rollbackKey, "SUCCEEDED", { ledgerTransactionId: rb.data.ledger_transaction_id });
    flowLog.info(
      { rollback_operator_transaction_id: rollbackKey, bet_ledger_transaction_id: bet.ledgerTransactionId },
      "bet reversed via provider rollback webhook",
    );
    return noop("reversed", rb.data);
  }

  await completeEngineRequest(rollbackKey, "FAILED", {
    retryable: rb.retryable,
    lastError: `${rb.error.code}: ${rb.error.message}`,
  });

  // Idempotent-VOID successes — the bet is already not-applied, so 200 the provider to stop it
  // retrying (checked by CODE, not status: ROLLBACK_ALREADY arrives as a "retryable" 409).
  if (rb.error.code === "ROLLBACK_ALREADY") {
    flowLog.info({ rollback_operator_transaction_id: rollbackKey }, "rollback idempotent: bet already reversed");
    return noop("already_reversed", null);
  }
  if (rb.error.code === "ROLLBACK_NOT_FOUND" || rb.status === 404) {
    flowLog.info({ rollback_operator_transaction_id: rollbackKey }, "rollback no-op: engine reports no bet to reverse");
    return noop("noop", null);
  }

  // Retryable transport/engine failure: hand to the reconciler (durable replay under the same
  // key) AND let the provider retry.
  if (rb.retryable) {
    await enqueueReconcile({ operatorTransactionId: rollbackKey, reason: "provider_rollback_failed_retryable" });
    flowLog.error(
      { rollback_operator_transaction_id: rollbackKey, engine_status: rb.status, err_code: rb.error.code },
      "provider rollback failed (retryable) — handed to reconciler",
    );
    return { ok: false, status: rb.status === 0 ? 502 : rb.status, error: rb.error };
  }

  // Terminal rejection (e.g. ROLLBACK_UNSUPPORTED 422, INVALID 400) — surface verbatim.
  flowLog.error(
    { rollback_operator_transaction_id: rollbackKey, engine_status: rb.status, err_code: rb.error.code },
    "provider rollback terminally rejected by engine",
  );
  return { ok: false, status: rb.status, error: rb.error };
}
