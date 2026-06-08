import { isPositiveMoneyString } from "@/lib/money";
import { trueEngine } from "@/lib/true-engine";
import type { ProviderSpinInput } from "@/schemas/game.schema";
import { beginEngineRequest, completeEngineRequest } from "@/services/engine-journal.service";
import { ProvisioningError, resolveTrueEnginePlayerId } from "@/services/player-provisioning.service";
import type { Currency, EngineBalances, EngineTxResult, TrueEngineErrorBody } from "@/types/true-engine";

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
 *   1. Resolve OUR user id → the engine player_id (provisioning lazily if needed).
 *   2. Derive STABLE, deterministic idempotency keys from the provider's txn id
 *      (`bet:<id>` / `win:<id>`), so a provider retry de-duplicates at the ledger and
 *      can never double-debit (this is what makes Ghost-Spin recovery work).
 *   3. sendBet → on success, sendWin (when win > 0) referencing the bet's
 *      `ledger_transaction_id`. Each step is journaled for crash recovery.
 */
export async function processProviderSpin(
  providerCode: string,
  input: ProviderSpinInput,
): Promise<SpinOutcome> {
  const engine = trueEngine();

  // 1) Identity bridge.
  let playerId: string;
  try {
    playerId = await resolveTrueEnginePlayerId(input.player_id);
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

  const betOpTxId = `bet:${input.provider_transaction_id}`;
  const winOpTxId = `win:${input.provider_transaction_id}`;
  const metadata = { provider: providerCode };

  // 2) Debit the bet first.
  await beginEngineRequest({ operatorTransactionId: betOpTxId, type: "BET", playerId, providerRef: input.provider_transaction_id });
  const bet = await engine.sendBet({
    operator_transaction_id: betOpTxId,
    player_id: playerId,
    currency: input.currency,
    amount: input.bet_amount,
    game_id: input.game_id,
    round_id: input.round_id,
    metadata,
  });
  if (!bet.ok) {
    await completeEngineRequest(betOpTxId, "FAILED");
    // e.g. 400 insufficient funds — stop; no win is attempted.
    return { ok: false, status: bet.status === 0 ? 502 : bet.status, error: bet.error };
  }
  await completeEngineRequest(betOpTxId, "SUCCEEDED", bet.data.ledger_transaction_id);

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

  // 3) Credit the win, linked to the bet's ledger transaction id.
  await beginEngineRequest({ operatorTransactionId: winOpTxId, type: "WIN", playerId, providerRef: input.provider_transaction_id });
  const win = await engine.sendWin({
    operator_transaction_id: winOpTxId,
    player_id: playerId,
    currency: input.currency,
    amount: input.win_amount,
    game_id: input.game_id,
    round_id: input.round_id,
    reference_transaction_id: bet.data.ledger_transaction_id,
    metadata,
  });
  if (!win.ok) {
    await completeEngineRequest(winOpTxId, "FAILED");
    // The bet was already debited. The win is safely retryable via the SAME winOpTxId
    // (the journal row records it); surface for reconciliation / saga compensation.
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
  await completeEngineRequest(winOpTxId, "SUCCEEDED", win.data.ledger_transaction_id);

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
