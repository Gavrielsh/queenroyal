import type { FlowContext } from "../lib/context";
import { assertKycAllows, KycGateError } from "../lib/kyc-policy";
import { childLogger } from "../lib/logger";
import { isPositiveMoneyString } from "../lib/money";
import { enqueueReconcile } from "../lib/reconcile-queue";
import { trueEngine } from "../lib/true-engine";
import type { ProviderSpinInput } from "../schemas/game.schema";
import type {
  BetPayload,
  Currency,
  EngineBalances,
  EngineTxResult,
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
