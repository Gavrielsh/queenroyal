"use client";

import { type ReactNode, useEffect, useState } from "react";

import { hasLiveSession, mockDevLogin } from "@/lib/apiClient";

/**
 * DEV-ONLY session bootstrap (Zone 3).
 *
 * Children stay UNMOUNTED until a live gateway session exists, so their mount-time
 * `GET /api/wallet` hydration never fires unauthenticated — the 401-on-first-paint class of
 * bug disappears structurally instead of being caught downstream. On refresh, a still-live
 * token in localStorage short-circuits straight to the children (no network round-trip); an
 * absent or expired token triggers `POST /api/auth/mock-login` first.
 *
 * Architecture guardrails:
 *   - In a production build this renders children immediately and never calls the route
 *     (which the gateway does not even register outside dev/test — it 404s there).
 *   - It stores ONLY the gateway-issued token. No user state, and absolutely no balances —
 *     the wallet mirror still hydrates itself exclusively from the gateway's answer.
 *   - If login fails (gateway down), children render anyway under a warning banner: every
 *     wallet consumer already degrades honestly via the store's "error"/stale status.
 */
export function DevAutoLogin({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"pending" | "ready" | "failed">(
    process.env.NODE_ENV === "production" ? "ready" : "pending",
  );

  useEffect(() => {
    if (phase !== "pending") return;
    let cancelled = false;
    void (async () => {
      try {
        if (!hasLiveSession()) await mockDevLogin();
        if (!cancelled) setPhase("ready");
      } catch {
        if (!cancelled) setPhase("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  if (phase === "pending") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <p className="animate-pulse text-[10px] uppercase tracking-[0.3em] text-zinc-600">
          connecting to cashier…
        </p>
      </div>
    );
  }

  return (
    <>
      {phase === "failed" && (
        <div
          role="alert"
          className="fixed inset-x-0 top-0 z-50 bg-red-950/95 px-4 py-2 text-center text-xs font-semibold text-red-200 ring-1 ring-red-500/40"
        >
          Dev auto-login failed — is the gateway running? Wallet requests will be unauthorized
          until it is.
        </div>
      )}
      {children}
    </>
  );
}
