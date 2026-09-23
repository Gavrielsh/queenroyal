"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { hasLiveSession, mockDevLogin, refreshAccessToken } from "@/lib/apiClient";
import { useSession } from "@/lib/auth/session";

/**
 * Holds a signed-in area back until a gateway session exists.
 *
 * Children stay UNMOUNTED until then, so their mount-time `GET /api/wallet` never fires
 * unauthenticated. In order:
 *   1. a live access token → render;
 *   2. otherwise rotate the HttpOnly refresh cookie (a returning player whose 15-minute token
 *      lapsed) → render;
 *   3. otherwise, in a development build that opted in with NEXT_PUBLIC_DEV_AUTO_LOGIN=1, the
 *      gateway's dev-only mock login (which a production gateway does not even register) —
 *      on the FIRST check only: a gateway that keeps rejecting the session cannot loop it,
 *      and a player who logs out stays logged out;
 *   4. otherwise → /login?next=<this page>.
 *
 * A sign-out while mounted (this tab or another) sends the player back through the check.
 * The gate stores nothing but the gateway-issued token, and never any balance (G1).
 */

export function devAutoLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === "1";
}

type Phase = "checking" | "ready" | "dev-login-failed";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const [phase, setPhase] = useState<Phase>("checking");
  /** True until the first check completes; only that check may fall back to the dev login. */
  const firstCheck = useRef(true);

  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    void (async () => {
      if (hasLiveSession() || (await refreshAccessToken())) {
        if (!cancelled) {
          firstCheck.current = false;
          setPhase("ready");
        }
        return;
      }
      // A superseded run (StrictMode's double effect, a pathname change) stops here, so only
      // the live run can spend the one dev login or navigate.
      if (cancelled) return;
      if (devAutoLoginEnabled() && firstCheck.current) {
        firstCheck.current = false;
        try {
          await mockDevLogin();
          if (!cancelled) setPhase("ready");
        } catch {
          if (!cancelled) setPhase("dev-login-failed");
        }
        return;
      }
      if (!cancelled) router.replace(`/login?next=${encodeURIComponent(pathname || "/casino")}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, pathname, router]);

  // Signed out while inside (logout here or in another tab): check again.
  useEffect(() => {
    if (phase === "ready" && session === null) setPhase("checking");
  }, [phase, session]);

  if (phase === "checking") {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5" role="status">
        <span aria-hidden="true" className="bg-gradient-to-b from-gc to-gc-deep bg-clip-text text-4xl text-transparent">
          ♛
        </span>
        <span
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-edge-strong border-t-gc"
        />
        <p className="animate-pulse text-[10px] uppercase tracking-[0.3em] text-ink-faint">connecting to cashier…</p>
      </div>
    );
  }

  return (
    <>
      {phase === "dev-login-failed" && (
        <div
          role="alert"
          className="fixed inset-x-0 top-16 z-40 border-b border-danger/40 bg-surface-1/95 px-4 py-2.5 text-center text-xs font-semibold text-danger backdrop-blur-md"
        >
          Dev auto-login failed — is the gateway running? Wallet requests will be unauthorized until it is.
        </div>
      )}
      {children}
    </>
  );
}
