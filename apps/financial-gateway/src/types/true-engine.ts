/**
 * Data Transfer Objects for the Go "True Engine" ledger, matching its ACTUAL wire contract
 * (`internal/api/dto.go`, `internal/api/casino.go`, `internal/repository`).
 *
 * Every monetary field is a decimal **string** (whole-coin units, ≤ 4 dp) — never a number.
 * The gateway validates the shape (`lib/money`) and forwards it verbatim.
 */

export type Currency = "GC" | "SC";

/** Engine balance snapshot. Money values are strings (e.g. "12.3400"). */
export interface EngineBalances {
  gc: string;
  sc_unplayed: string;
  sc_redeemable: string;
}

/** Optional, size-capped (≤ 512 B canonical JSON) operator metadata. */
export type EngineMetadata = Record<string, unknown>;

/** POST /api/v1/bet — debit a wager. */
export interface BetPayload {
  operator_transaction_id: string; // deterministic idempotency anchor (stable across retries)
  player_id: string; // the engine's player UUID (NOT our local user id)
  currency: Currency;
  amount: string; // decimal string, > 0
  game_id?: string;
  round_id?: string;
  metadata?: EngineMetadata;
}

/** POST /api/v1/win — credit a win, optionally linked to the originating bet. */
export interface WinPayload {
  operator_transaction_id: string;
  player_id: string;
  currency: Currency;
  amount: string; // decimal string, > 0
  game_id?: string;
  round_id?: string;
  reference_transaction_id?: string; // the BET's ledger_transaction_id (FK in the engine)
  metadata?: EngineMetadata;
}

/**
 * POST /api/v1/spin — the SERVER-AUTHORITATIVE game round.
 *
 * SECURITY: note the absent fields. There is no `win_amount`, no `multiplier`, and no
 * `outcome`. The engine draws the reels from crypto/rand, evaluates its own version-pinned
 * paytable, derives the payout, and settles the debit and credit in one transaction.
 *
 * This is the shape that replaces the player-facing use of BetPayload + WinPayload. Those
 * remain ONLY for third-party aggregator settlement, where a certified external provider
 * generates the outcome — and there the engine enforces an absolute win ceiling
 * (MAX_PROVIDER_WIN) because it cannot re-derive the payout itself.
 */
export interface SpinPayload {
  operator_transaction_id: string; // deterministic idempotency anchor
  player_id: string;
  currency: Currency;
  bet_amount: string; // decimal string, > 0 — the ONLY caller-supplied money value
  game_id?: string;
  round_id?: string;
  metadata?: EngineMetadata;
}

/** The engine's authoritative outcome record for one round. Presentation data only. */
export interface EngineSpinOutcome {
  game_id: string;
  paytable_version: string;
  reels: string[];
  line: "NONE" | "TWO_OF_A_KIND" | "THREE_OF_A_KIND";
  win_symbol?: string;
  multiplier: string;
}

/** POST /api/v1/spin result. */
export interface EngineSpinResult {
  operator_transaction_id: string;
  player_id: string;
  bet_ledger_transaction_id: string;
  win_ledger_transaction_id?: string;
  family: Currency;
  bet_amount: string;
  win_amount: string;
  outcome: EngineSpinOutcome;
  post_balances: EngineBalances;
  status: "PROCESSED" | "CACHED" | "GHOST_RECOVERED";
}

/** POST /api/v1/store/purchase — issue GC (+ optional SC_UNPLAYED promo) for a fiat buy. */
export interface PurchasePayload {
  operator_transaction_id: string;
  player_id: string;
  gc_amount: string; // decimal string, >= 0
  sc_promo_amount?: string; // decimal string, >= 0 (credited as SC_UNPLAYED)
  metadata?: EngineMetadata;
}

/** POST /api/v1/rollback — reverse a previously-committed BET. */
export interface RollbackPayload {
  operator_transaction_id: string; // the rollback's own (distinct) id
  player_id: string;
  reference_transaction_id: string; // the BET's ledger_transaction_id to reverse
  metadata?: EngineMetadata;
}

/**
 * POST /api/v1/session — non-locking balance snapshot. POST (not GET) because the engine's
 * HMAC covers only the raw body: the player id must travel INSIDE the signed body to be
 * authenticated at all.
 */
export interface SessionPayload {
  player_id: string;
}

/** POST /api/v1/session 2xx body (flat — NOT wrapped in `result`). */
export interface SessionBalancesResult {
  code: string; // "OK"
  player_id: string;
  balances: EngineBalances;
}

/** POST /api/v1/player/create — provision a player (idempotent on external_id). */
export interface CreatePlayerPayload {
  external_id: string; // our local user id
  username?: string;
  email?: string;
  country_code?: string;
  status?: string;
}

export type EngineTxStatus = "PROCESSED" | "CACHED" | "GHOST_RECOVERED";

/** The `result` object inside a successful bet/win/purchase/rollback envelope. */
export interface EngineTxResult {
  operator_code: string;
  operator_transaction_id: string;
  ledger_transaction_id: string;
  player_id: string;
  transaction_type: string; // "BET" | "WIN" | "DEPOSIT" | "WITHDRAWAL" | "ROLLBACK"
  family: string; // "GC" | "SC" | ""
  amount: string;
  post_balances: EngineBalances;
  status: EngineTxStatus | string;
}

/** POST /api/v1/player/create 2xx body (flat — NOT wrapped in `result`). */
export interface CreatePlayerResult {
  player_id: string;
  created: boolean; // false = already existed (idempotent replay)
  balances: EngineBalances;
}

/** Engine success envelope for bet/win/purchase/rollback: `{ code, result }`. */
export interface EngineSuccessEnvelope<T> {
  code: string; // "OK"
  result: T;
}

/** Engine error envelope: `{ code, message, trace_id }`. */
export interface TrueEngineErrorBody {
  code: string; // e.g. "INSUFFICIENT_FUNDS", "AUTHENTICATION_FAILED"
  message: string;
  trace_id?: string;
  details?: unknown;
}

/**
 * Discriminated result of any engine call. The client NEVER throws for HTTP/engine or
 * transport failures. `retryable` follows the engine's documented status policy (409 + 5xx +
 * timeout are safe to retry with the SAME operator_transaction_id).
 */
export type TrueEngineResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; retryable: boolean; error: TrueEngineErrorBody };
