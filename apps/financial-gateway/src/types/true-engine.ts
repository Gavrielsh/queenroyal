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

/**
 * POST /api/v1/store/redeem — debit SC_REDEEMABLE for a prize payout (money OUT).
 *
 * Mirrors the engine's `redeemDTO` (internal/api/casino.go) field for field. There is no
 * `currency`: redemption draws from SC_REDEEMABLE and nothing else, so naming a currency
 * would only create a way to ask for the wrong one.
 *
 * The engine — not this gateway — decides whether the debit is allowed: sufficient
 * SC_REDEEMABLE, playthrough discharged (ErrPlaythroughOutstanding), and a player status
 * that is not blocked. Zone 2 asks; Zone 1 answers.
 */
export interface RedeemPayload {
  operator_transaction_id: string; // deterministic idempotency anchor (stable across retries)
  player_id: string; // the engine's player UUID
  amount: string; // decimal string, > 0 — SC_REDEEMABLE only
  metadata?: EngineMetadata;
}

/**
 * POST /api/v1/store/redeem/refund — return SC_REDEEMABLE a redemption debited
 * but never paid out.
 *
 * `amount` MUST be exactly what the redemption debited. The engine credits what it is told and
 * cannot look the original up, so the gateway forwards its STORED decimal string verbatim —
 * never a recomputed one, and never a value that has been through a JS number.
 */
export interface RedemptionRefundPayload {
  operator_transaction_id: string; // deterministic anchor, derived from the redemption id
  player_id: string;
  amount: string; // decimal string, > 0 — exactly the debited figure
  reference_transaction_id?: string; // the redemption's ledger transaction id
  metadata?: EngineMetadata;
}

/**
 * The no-purchase route a grant came through. Mirrors the engine's `promo_grant_channel`
 * enum (migration 000014) exactly.
 *
 * A typed union rather than a free string because the distinction is the whole of the AMOE
 * defense: `AMOE` is the statutorily-required free entry method, `BONUS` is discretionary
 * marketing, and they are legally different acts. The engine stores it in a typed column
 * precisely so it cannot be a loose convention; widening it to `string` here would put the
 * looseness back one layer up.
 */
export type PromoChannel = "AMOE" | "BONUS" | "COMPENSATION";

/**
 * POST /api/v1/store/promo-grant — issue coins with NO purchase behind them.
 *
 * Mirrors the engine's `promoGrantDTO` (internal/api/casino.go) field for field.
 *
 * There is no `sc_redeemable_amount` and there cannot be one. `sc_amount` is credited to
 * SC_UNPLAYED and carries the standard 1x wagering requirement, the same as a purchaser's
 * promotional SC; a no-purchase path that could mint cashable tokens would be a withdrawal
 * channel with neither payment nor gameplay behind it, and the engine's allocator cannot
 * express it.
 *
 * `channel_reference` is REQUIRED by the engine when `channel` is "AMOE" — an AMOE record
 * that cannot be tied back to the entry it answers is an assertion rather than evidence.
 *
 * THE ENGINE DOES NOT CAP THIS. It issues what an authenticated operator asks for, because
 * its job is to record movements correctly rather than to decide who deserves one. Frequency
 * capping, rate limiting and fraud pre-checks are entirely this gateway's responsibility —
 * see prisma/schema.prisma's AmoeGrant and lib/amoe-policy.
 */
export interface PromoGrantPayload {
  operator_transaction_id: string; // deterministic anchor, derived from the AmoeGrant id
  player_id: string;
  gc_amount?: string; // decimal string, >= 0
  sc_amount?: string; // decimal string, >= 0 — credited as SC_UNPLAYED, never SC_REDEEMABLE
  channel: PromoChannel;
  channel_reference?: string; // required by the engine for the AMOE channel
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

/**
 * POST /api/v1/session 2xx body (flat — NOT wrapped in `result`).
 *
 * `status` and `playthrough_outstanding` are ADVISORY: the engine takes no lock for this read,
 * so both are true as of the read and may be stale by the time we act. They exist so a doomed
 * money operation can be refused before a signed round trip is spent on it — never to
 * authorise one. The engine re-checks both under the wallet lock on every money path, and
 * that check is what actually protects a suspended or self-excluded player.
 */
export interface SessionBalancesResult {
  code: string; // "OK"
  player_id: string;
  balances: EngineBalances;
  /** ACTIVE | SUSPENDED | SELF_EXCLUDED | KYC_PENDING | CLOSED. */
  status: string;
  /** SC still owed to the 1x wagering requirement, as a decimal string. */
  playthrough_outstanding: string;
}

/** POST /api/v1/player/create — provision a player (idempotent on external_id). */
export interface CreatePlayerPayload {
  external_id: string; // our local user id
  username?: string;
  email?: string;
  country_code?: string;
  status?: string;
}

/**
 * POST /api/v1/kyc/decision — relay a terminal identity-verification decision (Task C4).
 *
 * `external_id` is our local `User.id`, the SAME value already sent as `external_id` on
 * `CreatePlayerPayload` — Zone 1 addresses the player by it directly, so no lookup of the
 * engine's own `player_id` is needed to dispatch this call.
 *
 * `decided_at` is the PROVIDER's decision instant (RFC3339), never the receipt time: it is
 * the value Zone 1's own out-of-order resolution compares against its stored baseline.
 */
export interface KycDecisionPayload {
  external_id: string;
  event_id: string; // the provider's event id — Zone 1's idempotency anchor for this decision
  decision: "VERIFIED" | "REJECTED";
  decided_at: string; // RFC3339
  reason?: string;
}

/** The `result` object inside a successful /api/v1/kyc/decision envelope. */
export interface KycDecisionResult {
  player_id: string;
  event_id: string;
  decision: "VERIFIED" | "REJECTED";
  /** Whether THIS decision changed the engine's player status — false when Zone 1's own
   * out-of-order check found it superseded by an already-applied newer decision. */
  applied: boolean;
  reason?: string;
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
