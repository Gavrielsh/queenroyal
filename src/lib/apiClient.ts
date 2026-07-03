/**
 * Typed fetch client for the standalone Fastify financial gateway (Zone 2).
 *
 * Zone 3 rule: the browser talks ONLY to the gateway — never to a Next.js API
 * route. This module owns the base URL, the bearer-token injection, and the
 * error normalization so feature code never touches raw `fetch`.
 */

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
export function parseWalletEnvelope(payload: unknown): WalletBalancesDto {
  const malformed = (field: string): ApiError =>
    new ApiError(0, "MALFORMED_WALLET", `Wallet envelope failed validation at ${field}`);

  if (typeof payload !== "object" || payload === null) throw malformed("(root)");
  const envelope = payload as Record<string, unknown>;
  if (envelope.success !== true) throw malformed("success");

  const data = envelope.data;
  if (typeof data !== "object" || data === null) throw malformed("data");
  const balances = (data as Record<string, unknown>).balances;
  if (typeof balances !== "object" || balances === null) throw malformed("data.balances");

  const record = balances as Record<string, unknown>;
  const gc = record.gc;
  if (!isMoneyString(gc)) throw malformed("data.balances.gc");
  const scUnplayed = record.sc_unplayed;
  if (!isMoneyString(scUnplayed)) throw malformed("data.balances.sc_unplayed");
  const scRedeemable = record.sc_redeemable;
  if (!isMoneyString(scRedeemable)) throw malformed("data.balances.sc_redeemable");

  return { gc, scUnplayed, scRedeemable };
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
}

/**
 * Open a deposit PaymentIntent for a catalog package. The gateway owns the catalog, the
 * price, and the coin amounts — the browser sends only the package id plus a stable
 * idempotency key so a double-click can never open (or settle) the deposit twice.
 */
export async function initiateStorePurchase(
  packageId: string,
  idempotencyKey: string,
): Promise<PurchaseIntentDto> {
  const res = await apiClient.post<PurchaseEnvelope>("/store/purchase", { packageId, idempotencyKey });
  return { paymentIntentId: res.data.paymentIntentId, clientSecret: res.data.clientSecret };
}

/**
 * DEV-ONLY stand-in for `stripe.confirmCardPayment(clientSecret)`: asks the gateway's mock
 * PSP to mark the intent captured and run the same signed-webhook settlement the real Stripe
 * flow uses. The response carries no balances — the wallet is re-read afterwards.
 */
export async function confirmMockStripeDeposit(paymentIntentId: string): Promise<void> {
  await apiClient.post<{ success: true; data: { status: "settled" } }>(
    "/store/purchase/mock-confirm",
    { paymentIntentId },
  );
}
