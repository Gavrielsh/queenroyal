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

/** Error body shape the gateway returns on failures. */
interface GatewayErrorBody {
  code?: string;
  error?: string;
  message?: string;
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
    });
  } catch (cause) {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the gateway", { cause });
  }

  if (!response.ok) {
    let errorBody: GatewayErrorBody = {};
    try {
      errorBody = (await response.json()) as GatewayErrorBody;
    } catch {
      // Non-JSON error body — fall back to the status text.
    }
    throw new ApiError(
      response.status,
      errorBody.code,
      errorBody.message ?? errorBody.error ?? response.statusText,
    );
  }

  // 204-style responses settle to undefined; callers type that explicitly.
  if (response.status === 204) return undefined as TResponse;
  return (await response.json()) as TResponse;
}

export const apiClient = {
  get: <TResponse>(path: string) => request<TResponse>("GET", path),
  post: <TResponse>(path: string, body: unknown) => request<TResponse>("POST", path, body),
  put: <TResponse>(path: string, body: unknown) => request<TResponse>("PUT", path, body),
  delete: <TResponse>(path: string) => request<TResponse>("DELETE", path),
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

/** Gateway envelope for GET /api/wallet. Balances are the engine's decimal STRINGS. */
interface WalletEnvelope {
  success: true;
  data: {
    player_id: string;
    balances: {
      gc: string;
      sc_unplayed: string;
      sc_redeemable: string;
    };
  };
}

export interface WalletBalancesDto {
  gc: string;
  scUnplayed: string;
  scRedeemable: string;
}

/**
 * Fetch the authoritative wallet snapshot from the gateway (which reads it from the Go
 * ledger). The strings are renamed to camelCase but NEVER parsed into numbers — Zone 3
 * renders money, it does not compute it.
 */
export async function fetchWalletBalances(): Promise<WalletBalancesDto> {
  const res = await apiClient.get<WalletEnvelope>("/wallet");
  const { balances } = res.data;
  return {
    gc: balances.gc,
    scUnplayed: balances.sc_unplayed,
    scRedeemable: balances.sc_redeemable,
  };
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
