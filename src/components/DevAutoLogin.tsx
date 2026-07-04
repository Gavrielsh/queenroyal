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
 *     wallet consumer already degrades honestly via the wallet query's "error"/stale phase.
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
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5">
        <span
          aria-hidden="true"
          className="bg-gradient-to-b from-gc to-gc-deep bg-clip-text text-4xl text-transparent"
        >
          ♛
        </span>
        <span
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-edge-strong border-t-gc"
        />
        <p className="animate-pulse text-[10px] uppercase tracking-[0.3em] text-ink-faint">
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
          className="fixed inset-x-0 top-16 z-40 border-b border-danger/40 bg-surface-1/95 px-4 py-2.5 text-center text-xs font-semibold text-danger backdrop-blur-md"
        >
          Dev auto-login failed — is the gateway running? Wallet requests will be unauthorized
          until it is.
        </div>
      )}
      {children}
    </>
  );
}
