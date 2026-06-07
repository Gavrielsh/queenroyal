import { randomUUID } from "node:crypto";

import { trueEngine } from "@/lib/true-engine";
import type { AuthClaims } from "@/lib/jwt";
import type { SpinInput } from "@/schemas/game.schema";
import type { Currency, EngineBalances, EngineTxResult, TrueEngineErrorBody } from "@/types/true-engine";

export interface SpinSuccess {
  roundId: string;
  currency: Currency;
  bet: EngineTxResult;
  win: EngineTxResult | null;
  balances: EngineBalances;
}

export type SpinOutcome =
  | { ok: true; data: SpinSuccess }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * B2B game-aggregator adapter: translate a spin into ledger calls.
 *
 *   1. Generate ONE shared round_id.
 *   2. sendBet() and wait for 200 OK (stop on failure — nothing is credited).
 *   3. If winAmount > 0, sendWin() with the SAME round ("win_" + round_id).
 *
 * Each call carries its own UUID transaction_id (idempotency key), so any retry is
 * safe and a bet can never be paired with a duplicate win.
 */
export async function processSpin(user: AuthClaims, input: SpinInput): Promise<SpinOutcome> {
  const engine = trueEngine();
  const roundId = randomUUID();

  // 1 + 2) Debit the bet first.
  const betTransactionId = randomUUID();
  const bet = await engine.sendBet({
    transaction_id: betTransactionId,
    user_id: user.sub,
    round_id: roundId,
    currency: input.currency,
    amount: input.betAmount,
    game_id: input.gameId,
  });

  if (!bet.ok) {
    // e.g. 400 insufficient funds — stop; no win is attempted.
    return { ok: false, status: bet.status === 0 ? 502 : bet.status, error: bet.error };
  }

  // No win → return the post-bet state.
  if (input.winAmount <= 0) {
    return {
      ok: true,
      data: { roundId, currency: input.currency, bet: bet.data, win: null, balances: bet.data.balances },
    };
  }

  // 3) Credit the win against the SAME round, prefixed with "win_".
  const winTransactionId = randomUUID();
  const win = await engine.sendWin({
    transaction_id: winTransactionId,
    user_id: user.sub,
    round_id: `win_${roundId}`,
    bet_round_id: roundId,
    currency: input.currency,
    amount: input.winAmount,
    game_id: input.gameId,
  });

  if (!win.ok) {
    // The bet was already debited. The win is safely retryable thanks to idempotency
    // (winTransactionId + round "win_<round>"). Surface for reconciliation.
    return {
      ok: false,
      status: win.status === 0 ? 502 : win.status,
      error: {
        code: "WIN_SETTLEMENT_FAILED",
        message: `Bet accepted but win settlement failed: ${win.error.message}`,
        details: {
          roundId,
          winRoundId: `win_${roundId}`,
          betTransactionId,
          winTransactionId,
          engine: win.error.details,
        },
      },
    };
  }

  return {
    ok: true,
    data: { roundId, currency: input.currency, bet: bet.data, win: win.data, balances: win.data.balances },
  };
}
