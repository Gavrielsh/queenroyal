"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { logout, useSession } from "@/lib/auth/session";

/**
 * Signed out: "Log in" and "Sign up". Signed in: the account's email and "Log out".
 *
 * Logging out ends in a FULL page load of the home page, not a client-side push: it discards
 * every in-memory cache (wallet, bonus status) so the next player on this device never sees the
 * last one's, and it cannot race a signed-in page's own redirect to /login.
 */
export function AccountMenu() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);

  if (!session) {
    return (
      <div className="flex items-center gap-2">
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center whitespace-nowrap rounded-control px-2 font-display text-sm font-medium text-ink transition hover:text-gc sm:px-3"
        >
          Log in
        </Link>
        <Link href="/register" className="btn-candy btn-gold hidden min-h-11 px-4 text-sm sm:inline-flex">
          Sign up
        </Link>
      </div>
    );
  }

  async function onLogout() {
    setLeaving(true);
    await logout();
    queryClient.clear();
    window.location.assign("/");
  }

  return (
    <div className="flex items-center gap-2">
      {session.email ? (
        <span className="hidden max-w-[12rem] truncate text-xs font-bold text-ink-mute md:inline" title={session.email}>
          {session.email}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void onLogout()}
        disabled={leaving}
        className="inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap rounded-control border-2 border-edge-strong font-display text-sm font-medium text-ink transition hover:border-gc disabled:opacity-60 sm:px-3"
      >
        {/* Phone width: a door icon keeps the bar from overflowing; the label is still the
            button's accessible name. */}
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 sm:hidden" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
          <path d="M9 16l-4-4 4-4" />
          <path d="M5 12h11" />
        </svg>
        <span className="sr-only sm:not-sr-only">{leaving ? "Logging out…" : "Log out"}</span>
      </button>
    </div>
  );
}
