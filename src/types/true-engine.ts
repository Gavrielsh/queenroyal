/**
 * Data Transfer Objects for the Go "True Engine" ledger.
 *
 * Every monetary field is a non-negative INTEGER in the currency's smallest engine
 * unit. No floating point values are ever constructed or forwarded.
 */

export type Currency = "GC" | "SC";

/** Snapshot of a player's balances as reported by the engine (read-only here). */
export interface EngineBalances {
  gc: number;
  sc_unplayed: number;
  sc_redeemable: number;
}

/** Debit a wager from the player's balance. */
export interface BetPayload {
  transaction_id: string; // UUID v4 — also used as the idempotency key
  user_id: string;
  round_id: string; // shared id linking this bet to its settlement
  currency: Currency;
  amount: number; // integer, > 0
  game_id: string;
  provider?: string;
}

/** Credit a win to the player's balance, linked to the originating bet. */
export interface WinPayload {
  transaction_id: string; // UUID v4 — also used as the idempotency key
  user_id: string;
  round_id: string; // "win_" + bet round id
  bet_round_id: string; // the originating bet's round id
  currency: Currency;
  amount: number; // integer, > 0
  game_id: string;
  provider?: string;
}

/** Credit purchased coins after a confirmed fiat charge. */
export interface DepositPayload {
  transaction_id: string; // UUID v4 — also used as the idempotency key
  user_id: string;
  gc: number; // integer, >= 0
  sc: number; // integer, >= 0 (credited as SC_Unplayed)
  usd_cents: number; // integer cents actually charged by the PSP
  package_id: string;
  payment_ref: string; // PSP reference (e.g. Stripe PaymentIntent id)
}

/** Best-effort typing of the engine's success envelope. Engine remains authoritative. */
export interface EngineTxResult {
  transaction_id: string;
  round_id?: string;
  status: string; // e.g. "applied" | "duplicate"
  balances: EngineBalances;
}

/** Normalized error body surfaced to the caller (and onward to the frontend). */
export interface TrueEngineErrorBody {
  code: string; // e.g. "INSUFFICIENT_FUNDS", "UNAUTHORIZED_SIGNATURE"
  message: string;
  details?: unknown;
}

/**
 * Discriminated result of any engine call. The client NEVER throws for HTTP/engine
 * or transport failures — callers branch on `ok` so a bad ledger response can never
 * crash the Node process.
 */
export type TrueEngineResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: TrueEngineErrorBody };
