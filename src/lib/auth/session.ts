"use client";

import { useSyncExternalStore } from "react";

import { ApiError, apiClient } from "@/lib/apiClient";
import { clearAccessToken, decodeClaims, readAccessToken, subscribeAccessToken, writeAccessToken } from "@/lib/auth/token";

/**
 * Player sign-up, sign-in and sign-out against the gateway (`/api/auth/*`).
 *
 * Every function stores ONLY the access token the gateway returns (G1). The refresh token
 * lives in an HttpOnly cookie the gateway sets; this code never sees it.
 */

export interface RegisterForm {
  email: string;
  password: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
  /** USPS state code. */
  residenceState: string;
  acceptTerms: boolean;
}

/** A sign-in or sign-up that did not produce a session, with copy fit to show the player. */
export class AuthFormError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    /** The form field the message belongs to, when there is one. */
    readonly field: keyof RegisterForm | null = null,
  ) {
    super(message);
    this.name = "AuthFormError";
  }
}

function tokenFrom(payload: unknown): string {
  const token = (payload as { data?: { accessToken?: unknown } } | undefined)?.data?.accessToken;
  if (typeof token !== "string" || token === "") {
    throw new AuthFormError("Something went wrong signing you in. Please try again.", "MALFORMED_SESSION");
  }
  return token;
}

/** Player-facing copy per gateway failure. */
export function toAuthFormError(err: unknown): AuthFormError {
  if (err instanceof AuthFormError) return err;
  const code = err instanceof ApiError ? (err.code ?? null) : null;
  const status = err instanceof ApiError ? err.status : 0;
  switch (code) {
    case "INVALID_CREDENTIALS":
      return new AuthFormError("That email and password don't match an account.", code);
    case "EMAIL_TAKEN":
      return new AuthFormError("An account with this email already exists. Try logging in.", code, "email");
    case "UNDERAGE":
      return new AuthFormError("You must be 18 or older to play.", code, "dateOfBirth");
    case "STATE_NOT_ELIGIBLE":
      return new AuthFormError("QueenRoyal isn't available in your state yet.", code, "residenceState");
    case "RATE_LIMITED":
      return new AuthFormError("Too many attempts. Please wait a minute and try again.", code);
    case "VALIDATION_ERROR":
      return new AuthFormError("Please check the highlighted details and try again.", code);
  }
  if (status === 0 || status >= 500) {
    return new AuthFormError("We can't reach the casino right now. Please try again shortly.", code);
  }
  return new AuthFormError("Something went wrong. Please try again.", code);
}

export async function login(email: string, password: string): Promise<void> {
  try {
    writeAccessToken(tokenFrom(await apiClient.post<unknown>("/auth/login", { email, password })));
  } catch (err) {
    throw toAuthFormError(err);
  }
}

export async function register(form: RegisterForm): Promise<void> {
  try {
    writeAccessToken(tokenFrom(await apiClient.post<unknown>("/auth/register", form)));
  } catch (err) {
    throw toAuthFormError(err);
  }
}

/**
 * End the session. The local token is dropped FIRST and unconditionally — a player who asked to
 * sign out is signed out on this device even when the gateway cannot be reached to revoke.
 */
export async function logout(): Promise<void> {
  clearAccessToken();
  try {
    await apiClient.post<unknown>("/auth/logout", {});
  } catch {
    // The gateway clears and revokes the cookie when it can; nothing more to do here.
  }
}

// ── Who is signed in (UI only) ──────────────────────────────────────────────

export interface SessionView {
  email: string | null;
}

let cachedToken: string | null | undefined;
let cachedView: SessionView | null = null;

function snapshot(): SessionView | null {
  const token = readAccessToken();
  if (token !== cachedToken) {
    cachedToken = token;
    // Any stored token is a session; claims only supply the label.
    const email = token ? decodeClaims(token)?.email : undefined;
    cachedView = token ? { email: typeof email === "string" ? email : null } : null;
  }
  return cachedView;
}

/**
 * The signed-in player as the stored token names them, or null. For display only (the account
 * menu); access is decided by the gateway on every request. An EXPIRED token still counts as
 * signed in here — the next request refreshes it silently or signs the player out.
 */
export function useSession(): SessionView | null {
  return useSyncExternalStore(subscribeAccessToken, snapshot, () => null);
}

/**
 * A post-auth destination from `?next=`, accepted only as a same-origin path. Anything else —
 * absolute URLs, protocol-relative `//host`, backslash tricks — falls back to the casino floor,
 * so the login page cannot be used as an open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/casino";
  return raw;
}
