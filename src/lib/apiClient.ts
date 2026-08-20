/**
 * Typed fetch client for the standalone Fastify financial gateway (Zone 2).
 *
 * Zone 3 rule: the browser talks ONLY to the gateway — never to a Next.js API
 * route. This module owns the base URL, the bearer-token injection, and the
 * error normalization so feature code never touches raw `fetch`.
 */

import { type AttemptToken, peekAttemptToken } from "@/lib/purchaseIntent";
import { type SpinAttemptToken } from "@/lib/spinIntent";

const GATEWAY_BASE_URL = (
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000/api"
).replace(/\/+$/, "");

/** localStorage key + cookie name under which the gateway session token lives. */
const ACCESS_TOKEN_KEY = "qr_access_token";

/** Normalized failure raised for any non-2xx gateway response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    /** Machine-readable code from the gateway (e.g. "INSUFFICIENT_FUNDS"), if any. */
    public readonly code: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

/**
 * Extract `{ code, message }` from a gateway failure body. The canonical envelope nests them —
 * `{ success: false, error: { code, message } }` (apps/financial-gateway/src/lib/reply.ts) —
 * while flat `{ code, message }` is kept as a defensive fallback for non-canonical origins
 * (intermediary proxies, legacy handlers). Unrecognized shapes yield `{}`.
 */
function extractGatewayError(body: unknown): { code?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;

  const nested = record.error;
  if (typeof nested === "object" && nested !== null) {
    const err = nested as Record<string, unknown>;
    return {
      code: typeof err.code === "string" ? err.code : undefined,
      message: typeof err.message === "string" ? err.message : undefined,
    };
  }

  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message:
      typeof record.message === "string"
        ? record.message
        : typeof nested === "string"
          ? nested
          : undefined,
  };
}

/** True for the AbortError exception raised when an AbortSignal cancels a fetch. */
function isAbortException(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * True when a thrown error is this client's normalized abort (`ApiError` code "ABORTED").
 * Aborts are deliberate cancellations (unmount/supersede) — callers keep them silent; they
 * must never surface as a transport fault or an error toast.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "ABORTED";
}

/** Options accepted by every request; `signal` lets React Query cancel superseded reads. */
export interface RequestOptions {
  signal?: AbortSignal;
}

function readAccessToken(): string | null {
  // Guard for SSR/prerender — the token only exists in the browser.
  if (typeof window === "undefined") return null;

  const fromStorage = window.localStorage.getItem(ACCESS_TOKEN_KEY);
  if (fromStorage) return fromStorage;

  const cookie = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${ACCESS_TOKEN_KEY}=`));
  return cookie ? decodeURIComponent(cookie.slice(ACCESS_TOKEN_KEY.length + 1)) : null;
}

async function request<TResponse>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<TResponse> {
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");

  const token = readAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${GATEWAY_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // The gateway authenticates via the bearer header; cookies stay out of it.
      credentials: "omit",
      signal: opts?.signal,
    });
  } catch (cause) {
    // An abort is a deliberate cancellation, NEVER a transport fault — classify it first so
    // it can stay silent instead of surfacing as "cashier unreachable".
    if (opts?.signal?.aborted || isAbortException(cause)) {
      throw new ApiError(0, "ABORTED", "Request aborted", { cause });
    }
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the gateway", { cause });
  }

  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined; // Non-JSON error body — fall back to the status text.
    }
    const { code, message } = extractGatewayError(parsed);
    throw new ApiError(response.status, code, message ?? response.statusText);
  }

  // 204-style responses settle to undefined; callers type that explicitly.
  if (response.status === 204) return undefined as TResponse;

  try {
    return (await response.json()) as TResponse;
  } catch (cause) {
    // The signal can fire between the response resolving and the body finishing.
    if (opts?.signal?.aborted || isAbortException(cause)) {
      throw new ApiError(0, "ABORTED", "Request aborted", { cause });
    }
    // A 2xx whose body isn't parseable JSON breaks the client contract; normalize it instead
    // of leaking a raw SyntaxError into feature code.
    throw new ApiError(response.status, "MALFORMED_RESPONSE", "Gateway returned an unparseable body", {
      cause,
    });
  }
}

export const apiClient = {
  get: <TResponse>(path: string, opts?: RequestOptions) => request<TResponse>("GET", path, undefined, opts),
  post: <TResponse>(path: string, body: unknown, opts?: RequestOptions) =>
    request<TResponse>("POST", path, body, opts),
  put: <TResponse>(path: string, body: unknown, opts?: RequestOptions) =>
    request<TResponse>("PUT", path, body, opts),
  delete: <TResponse>(path: string, opts?: RequestOptions) =>
    request<TResponse>("DELETE", path, undefined, opts),
} as const;

// ── Dev-only session bootstrap ───────────────────────────────────────────────

/**
 * Check the access token's `exp` with a plain base64url decode — NO signature verification
 * (the gateway is the only verifier; this is purely a UX freshness probe so we know when to
 * re-login). 30s of slack treats a token about to lapse mid-flow as already dead.
 */
function tokenIsLive(token: string): boolean {
  const payload = token.split(".")[1];
  if (!payload) return false;
  try {
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    return typeof decoded.exp === "number" && decoded.exp * 1000 > Date.now() + 30_000;
  } catch {
    return false;
  }
}

/** True when a non-expired gateway access token is present in the browser. */
export function hasLiveSession(): boolean {
  const token = readAccessToken();
  return token !== null && tokenIsLive(token);
}

interface MockLoginEnvelope {
  success: true;
  data: {
    user: { id: string; email: string; kycStatus: string };
    accessToken: string;
  };
}

/**
 * DEV-ONLY: obtain a session from the gateway's mock-login route and store the access token
 * where every other request reads it. The route does not exist in production builds of the
 * gateway (404), so this can never become a production login path. Throws ApiError on
 * failure — the caller (DevAutoLogin) owns the degraded-UX decision.
 */
export async function mockDevLogin(): Promise<void> {
  const res = await apiClient.post<MockLoginEnvelope>("/auth/mock-login", {});
  window.localStorage.setItem(ACCESS_TOKEN_KEY, res.data.accessToken);
}

// ── Wallet mirror ────────────────────────────────────────────────────────────

/**
 * Engine wire format for money: an unsigned decimal STRING with an integer part and at most
 * 4 fractional digits (`"12.3400"`, `"0"`, `"20000"`). No sign, no exponent, no bare or
 * dangling dot. Mirrors the authoritative gateway contract
 * (apps/financial-gateway/src/lib/money.ts `MONEY_REGEX`), which itself mirrors the engine's
 * `NUMERIC(18,4)` JSON-string serialization.
 */
export const MONEY_STRING_REGEX = /^\d+(\.\d{1,4})?$/;

/** True iff `value` is a money string in the engine wire format above. */
export function isMoneyString(value: unknown): value is string {
  return typeof value === "string" && MONEY_STRING_REGEX.test(value);
}

/** Camel-cased, runtime-validated wallet snapshot. Values are the engine's strings, verbatim. */
export interface WalletBalancesDto {
  gc: string;
  scUnplayed: string;
  scRedeemable: string;
}

/**
 * Validate the `GET /api/wallet` envelope — `{ success: true, data: { player_id, balances:
 * { gc, sc_unplayed, sc_redeemable } } }` — BEFORE any value can reach the query cache. A
 * payload that fails shape or money-format validation becomes an `ApiError` with code
 * "MALFORMED_WALLET" (a query ERROR, never cached data). `player_id` is not consumed by
 * Zone 3 and is deliberately not validated.
 *
 * Security note: failure messages name the offending FIELD but never echo its value — a
 * payload the validator rejected is untrusted by definition and stays out of logs/telemetry.
 *
 * Exported for reuse: the M4 realtime path must pass every push through this same gate
 * before `setQueryData` ("realtime is a faster source, never a looser gate").
 */
/**
 * Validate the engine's `{ gc, sc_unplayed, sc_redeemable }` balance block and rename it to
 * camelCase. Shared by every envelope that carries balances (the wallet read and the spin
 * settlement) so there is exactly ONE definition of "a balance block we accept" — a second,
 * looser copy is how a money byte eventually slips past validation.
 *
 * `malformed` and `path` are injected so each caller keeps its own error code and field
 * breadcrumbs (`data.balances.gc` vs `data.post_balances.gc`).
 */
function parseBalancesRecord(
  balances: unknown,
  malformed: (field: string) => ApiError,
  path: string,
): WalletBalancesDto {
  if (typeof balances !== "object" || balances === null) throw malformed(path);

  const record = balances as Record<string, unknown>;
  const gc = record.gc;
  if (!isMoneyString(gc)) throw malformed(`${path}.gc`);
  const scUnplayed = record.sc_unplayed;
  if (!isMoneyString(scUnplayed)) throw malformed(`${path}.sc_unplayed`);
  const scRedeemable = record.sc_redeemable;
  if (!isMoneyString(scRedeemable)) throw malformed(`${path}.sc_redeemable`);

  return { gc, scUnplayed, scRedeemable };
}

export function parseWalletEnvelope(payload: unknown): WalletBalancesDto {
  const malformed = (field: string): ApiError =>
    new ApiError(0, "MALFORMED_WALLET", `Wallet envelope failed validation at ${field}`);

  if (typeof payload !== "object" || payload === null) throw malformed("(root)");
  const envelope = payload as Record<string, unknown>;
  if (envelope.success !== true) throw malformed("success");

  const data = envelope.data;
  if (typeof data !== "object" || data === null) throw malformed("data");

  return parseBalancesRecord((data as Record<string, unknown>).balances, malformed, "data.balances");
}

/**
 * Fetch the authoritative wallet snapshot from the gateway (which reads it from the Go
 * ledger). The response is runtime-validated (envelope shape + money-string format), and the
 * strings are renamed to camelCase but NEVER parsed into numbers — Zone 3 renders money, it
 * does not compute it. Pass React Query's `signal` so a superseded or unmounted read is
 * genuinely cancelled rather than left to race.
 */
export async function fetchWalletBalances(opts?: RequestOptions): Promise<WalletBalancesDto> {
  const payload = await apiClient.get<unknown>("/wallet", opts);
  return parseWalletEnvelope(payload);
}

// ── Cashier (store) ──────────────────────────────────────────────────────────

/**
 * SERVER-ANCHORED IDEMPOTENCY CONTRACT (verified read-only against the gateway source):
 *
 * The attempt token this client sends as `idempotencyKey` is the gateway's attempt anchor
 * (store.service.ts): the PSP PaymentIntent is GET-OR-CREATE on it (payments/mock.ts keys
 * intents by idempotencyKey and returns the same intent + client_secret on a replay; real
 * Stripe's Idempotency-Key behaves identically), the intent journal collapses duplicates via
 * a UNIQUE constraint + ON CONFLICT DO NOTHING (engine-journal.repository.ts), and the
 * ledger credit's `operator_transaction_id` is `deposit:<token>`, which the Go engine
 * de-duplicates (23505 ghost recovery). A retry with the SAME token therefore converges on
 * one charge and one credit across tabs, reloads, and devices — which is exactly why the
 * token parameter below is the branded AttemptToken: only a value retained by the
 * purchaseIntent lifecycle can reach the wire. The gateway treats the key as OPTIONAL and
 * mints a per-call UUID when absent — so sending the retained token is load-bearing, not
 * advisory.
 */

/** Gateway envelope for POST /api/store/purchase (async PSP flow: nothing is captured yet). */
interface PurchaseEnvelope {
  success: true;
  data: {
    status: "requires_payment_confirmation";
    paymentIntentId: string;
    clientSecret: string;
    operatorTransactionId: string;
  };
}

export interface PurchaseIntentDto {
  paymentIntentId: string;
  /** With a real PSP this is what Stripe.js confirms the card against (3DS/SCA included). */
  clientSecret: string;
  /** The logical purchase this intent belongs to — binds the confirm step to its attempt. */
  packageId: string;
  /** The attempt token the intent was opened under (the server's idempotency anchor). */
  token: AttemptToken;
}

/**
 * Open a deposit PaymentIntent for a catalog package. The gateway owns the catalog, the
 * price, and the coin amounts — the browser sends only the package id plus the RETAINED
 * attempt token (compile-enforced: a raw string/UUID is a type error), so a retry can never
 * open (or settle) the deposit twice.
 */
export async function initiateStorePurchase(
  packageId: string,
  attemptToken: AttemptToken,
): Promise<PurchaseIntentDto> {
  const res = await apiClient.post<PurchaseEnvelope>("/store/purchase", {
    packageId,
    idempotencyKey: attemptToken,
  });
  return {
    paymentIntentId: res.data.paymentIntentId,
    clientSecret: res.data.clientSecret,
    packageId,
    token: attemptToken,
  };
}

/** Outcome of a confirm request; `already_settled` means the guard skipped the wire call. */
export type DepositConfirmOutcome = { status: "settled" } | { status: "already_settled" };

/**
 * DEV-ONLY stand-in for `stripe.confirmCardPayment(clientSecret)`: asks the gateway's mock
 * PSP to mark the intent captured and run the same signed-webhook settlement the real Stripe
 * flow uses. The response carries no balances — the wallet is re-read afterwards.
 *
 * Confirm-after-settle guard: if the intent's attempt token is no longer the LIVE token for
 * its package (cleared by a settle/abandon here or in a peer tab, or superseded by a newer
 * attempt), the money question is already answered — the confirm is a local no-op and never
 * touches the wire. (The server side is idempotent too: the journal never regresses a final
 * intent — this guard just avoids asking a question whose answer is known.)
 */
export async function confirmMockStripeDeposit(intent: PurchaseIntentDto): Promise<DepositConfirmOutcome> {
  if (peekAttemptToken(intent.packageId) !== intent.token) {
    return { status: "already_settled" };
  }
  await apiClient.post<{ success: true; data: { status: "settled" } }>(
    "/store/purchase/mock-confirm",
    { paymentIntentId: intent.paymentIntentId },
  );
  return { status: "settled" };
}

// ── Game (server-authoritative spin) ─────────────────────────────────────────

/**
 * The wagering families the player may address. The engine routes the SC sub-buckets itself
 * (bet: SC_UNPLAYED → SC_REDEEMABLE; win: SC_REDEEMABLE only), so the sub-buckets are
 * deliberately NOT nameable here.
 */
export type SpinCurrency = "GC" | "SC";

/** Line classifications the engine's evaluator can return (internal/game/spin.go). */
export const SPIN_LINES = ["NONE", "TWO_OF_A_KIND", "THREE_OF_A_KIND"] as const;
export type SpinLine = (typeof SPIN_LINES)[number];

/**
 * A stake multiplier as an unsigned decimal string. Deliberately NOT validated with
 * `MONEY_STRING_REGEX`: a multiplier is not money and is not bound by the ledger's
 * `NUMERIC(18,4)` scale, so capping it at 4 dp would reject a legitimate future paytable.
 */
const MULTIPLIER_STRING_REGEX = /^\d+(\.\d+)?$/;

/** Upper bound on reels we will accept from the wire — a sanity cap, not a game rule. */
const MAX_REELS = 10;

/**
 * The engine's authoritative outcome record for one round. PRESENTATION DATA ONLY: the payout
 * was already derived, bounded, and settled server-side before this reached the browser.
 * Nothing here is used to compute a balance.
 */
export interface SpinOutcomeDto {
  gameId: string;
  paytableVersion: string;
  /** Symbol ids as drawn, left to right (e.g. `["CHERRY", "CHERRY", "BELL"]`). */
  reels: readonly string[];
  line: SpinLine;
  /** The paying symbol; absent when `line` is `NONE`. */
  winSymbol: string | null;
  /** Stake multiple this outcome paid, as a decimal string. `"0"` for a loss. */
  multiplier: string;
}

/**
 * A settled round, exactly as the ledger recorded it.
 *
 * `status` mirrors the engine's idempotency verdict:
 *   - `PROCESSED`        — a fresh draw, settled now.
 *   - `CACHED`           — the Redis barrier replayed a response for this same key.
 *   - `GHOST_RECOVERED`  — the DB had already committed this key (the response to the first
 *                          attempt was lost); the ORIGINAL outcome was reconstructed. Funds
 *                          were NOT deducted a second time.
 * All three are successes and all three render identically — a recovered round is a real
 * round.
 */
export interface SpinResultDto {
  operatorTransactionId: string;
  betLedgerTransactionId: string;
  winLedgerTransactionId: string | null;
  family: SpinCurrency;
  /** Verbatim engine decimal strings — rendered, never arithmetic. */
  betAmount: string;
  winAmount: string;
  outcome: SpinOutcomeDto;
  /**
   * The ledger's post-state for this round.
   *
   * ⚠️ G1 — DO NOT WRITE THIS INTO THE WALLET CACHE. The wallet has exactly one writer
   * (`walletQueryFn`); seeding the cache from a mutation response would make this a second
   * writer that races in-flight reads and drifts from the ledger the moment anything else
   * settles. It is carried for diagnostics and assertions only. Balance updates happen by
   * invalidating the cache and re-reading — never by copying a number sideways.
   */
  postBalances: WalletBalancesDto;
  status: "PROCESSED" | "CACHED" | "GHOST_RECOVERED";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate the `POST /api/spin` envelope — `{ success: true, data: { …engine spin result } }`
 * (apps/financial-gateway/src/routes/spin.ts → `okBody(outcome.data)`, whose payload is the
 * engine's `EngineSpinResult`) — BEFORE any value can reach React state.
 *
 * A payload that fails shape or money-format validation becomes an `ApiError` with code
 * "MALFORMED_SPIN". Same rule as the wallet gate: failure messages name the offending FIELD
 * but never echo its value.
 */
export function parseSpinEnvelope(payload: unknown): SpinResultDto {
  const malformed = (field: string): ApiError =>
    new ApiError(0, "MALFORMED_SPIN", `Spin envelope failed validation at ${field}`);

  if (typeof payload !== "object" || payload === null) throw malformed("(root)");
  const envelope = payload as Record<string, unknown>;
  if (envelope.success !== true) throw malformed("success");

  const data = envelope.data;
  if (typeof data !== "object" || data === null) throw malformed("data");
  const record = data as Record<string, unknown>;

  const operatorTransactionId = record.operator_transaction_id;
  if (!isNonEmptyString(operatorTransactionId)) throw malformed("data.operator_transaction_id");

  const betLedgerTransactionId = record.bet_ledger_transaction_id;
  if (!isNonEmptyString(betLedgerTransactionId)) throw malformed("data.bet_ledger_transaction_id");

  // Present only when the round paid — a loss books no WIN leg.
  const rawWinLedgerId = record.win_ledger_transaction_id;
  if (rawWinLedgerId !== undefined && rawWinLedgerId !== null && !isNonEmptyString(rawWinLedgerId)) {
    throw malformed("data.win_ledger_transaction_id");
  }

  const family = record.family;
  if (family !== "GC" && family !== "SC") throw malformed("data.family");

  const betAmount = record.bet_amount;
  if (!isMoneyString(betAmount)) throw malformed("data.bet_amount");
  const winAmount = record.win_amount;
  if (!isMoneyString(winAmount)) throw malformed("data.win_amount");

  const status = record.status;
  if (status !== "PROCESSED" && status !== "CACHED" && status !== "GHOST_RECOVERED") {
    throw malformed("data.status");
  }

  const postBalances = parseBalancesRecord(record.post_balances, malformed, "data.post_balances");

  const outcomeRaw = record.outcome;
  if (typeof outcomeRaw !== "object" || outcomeRaw === null) throw malformed("data.outcome");
  const outcomeRecord = outcomeRaw as Record<string, unknown>;

  const gameId = outcomeRecord.game_id;
  if (!isNonEmptyString(gameId)) throw malformed("data.outcome.game_id");
  const paytableVersion = outcomeRecord.paytable_version;
  if (!isNonEmptyString(paytableVersion)) throw malformed("data.outcome.paytable_version");

  const reelsRaw = outcomeRecord.reels;
  if (!Array.isArray(reelsRaw) || reelsRaw.length === 0 || reelsRaw.length > MAX_REELS) {
    throw malformed("data.outcome.reels");
  }
  const reels: string[] = [];
  for (const [index, symbol] of reelsRaw.entries()) {
    if (!isNonEmptyString(symbol)) throw malformed(`data.outcome.reels[${index}]`);
    reels.push(symbol);
  }

  const line = outcomeRecord.line;
  if (!SPIN_LINES.some((candidate) => candidate === line)) throw malformed("data.outcome.line");

  const rawWinSymbol = outcomeRecord.win_symbol;
  if (rawWinSymbol !== undefined && rawWinSymbol !== null && !isNonEmptyString(rawWinSymbol)) {
    throw malformed("data.outcome.win_symbol");
  }

  const multiplier = outcomeRecord.multiplier;
  if (typeof multiplier !== "string" || !MULTIPLIER_STRING_REGEX.test(multiplier)) {
    throw malformed("data.outcome.multiplier");
  }

  return {
    operatorTransactionId,
    betLedgerTransactionId,
    winLedgerTransactionId: isNonEmptyString(rawWinLedgerId) ? rawWinLedgerId : null,
    family,
    betAmount,
    winAmount,
    outcome: {
      gameId,
      paytableVersion,
      reels,
      line: line as SpinLine,
      winSymbol: isNonEmptyString(rawWinSymbol) ? rawWinSymbol : null,
      multiplier,
    },
    postBalances,
    status,
  };
}

/** What the browser is allowed to say about a spin. Note what is absent. */
export interface SpinRequestDto {
  gameId: string;
  currency: SpinCurrency;
  /** The stake — the ONLY monetary value the player controls. A validated decimal string. */
  betAmount: string;
  /** The RETAINED attempt token (the gateway's idempotency anchor for `spin:<token>`). */
  attemptToken: SpinAttemptToken;
}

/**
 * Place a server-authoritative spin.
 *
 * SECURITY — read the absent fields as carefully as the present ones. There is no
 * `winAmount`, no `multiplier`, no `outcome`, and no `reels` in the request. The player says
 * only how much to stake and which game; the ENGINE draws the reels from crypto/rand and
 * derives the payout from its own version-pinned paytable. The response is the first time an
 * outcome exists anywhere, and it arrives already settled in the ledger.
 *
 * The attempt token is compile-enforced as a branded `SpinAttemptToken`, so only a value that
 * went through the `spinIntent` retain/rotate lifecycle can anchor a wager — a raw UUID is a
 * type error.
 */
export async function submitSpin(request: SpinRequestDto): Promise<SpinResultDto> {
  const payload = await apiClient.post<unknown>("/spin", {
    idempotencyKey: request.attemptToken,
    currency: request.currency,
    betAmount: request.betAmount,
    gameId: request.gameId,
  });
  return parseSpinEnvelope(payload);
}
