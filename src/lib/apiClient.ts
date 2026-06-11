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
