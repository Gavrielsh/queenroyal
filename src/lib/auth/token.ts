/**
 * The browser's copy of the gateway access token — the ONLY session state Zone 3 holds.
 *
 * The token is short-lived (15m) and sent as a bearer header; the long-lived refresh token is
 * an HttpOnly cookie the gateway sets on `/api/auth` and this code can never read. Reading the
 * token's claims here is a UX convenience (who is signed in, is it about to expire) — there is
 * NO signature check, the gateway is the only verifier.
 *
 * Subscribers are notified on every change, in this tab and (via the `storage` event) in other
 * tabs, so a logout in one tab signs the account menu out everywhere.
 */

export const ACCESS_TOKEN_KEY = "qr_access_token";

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function readAccessToken(): string | null {
  // Guard for SSR/prerender — the token only exists in the browser.
  if (typeof window === "undefined") return null;

  const fromStorage = window.localStorage.getItem(ACCESS_TOKEN_KEY);
  if (fromStorage) return fromStorage;

  const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${ACCESS_TOKEN_KEY}=`));
  return cookie ? decodeURIComponent(cookie.slice(ACCESS_TOKEN_KEY.length + 1)) : null;
}

export function writeAccessToken(token: string): void {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
  notify();
}

export function clearAccessToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  notify();
}

export function subscribeAccessToken(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ACCESS_TOKEN_KEY) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export interface TokenClaims {
  sub?: string;
  email?: string;
  exp?: number;
}

/** Decode a JWT payload with a plain base64url parse. Null for anything that is not a JWT. */
export function decodeClaims(token: string): TokenClaims | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const decoded = JSON.parse(json) as unknown;
    return typeof decoded === "object" && decoded !== null ? (decoded as TokenClaims) : null;
  } catch {
    return null;
  }
}

/** 30s of slack treats a token about to lapse mid-flow as already dead. */
export function tokenIsLive(token: string, now: number = Date.now()): boolean {
  const exp = decodeClaims(token)?.exp;
  return typeof exp === "number" && exp * 1000 > now + 30_000;
}
