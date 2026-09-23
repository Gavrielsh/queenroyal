"use client";

import { useEffect, useState } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";

const SESSION_KEY = "qr-entrance-seen";

/**
 * Branded entrance splash: the crown drops in, the wordmark rises, then everything fades and
 * `onDone` fires (the casino floor opens the Daily Wheel from there). Shown once per browser
 * session; the "seen" flag is a convenience, so a storage failure just means it shows again.
 */
export function EntranceIntro({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<"checking" | "showing" | "leaving" | "gone">("checking");

  useEffect(() => {
    let seen = false;
    try {
      seen = window.sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      // Blocked storage: show the splash; it is short and harmless.
    }
    if (seen) {
      setState("gone");
      onDone();
      return undefined;
    }
    setState("showing");
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const leave = setTimeout(() => setState("leaving"), reduced ? 300 : 2000);
    const done = setTimeout(
      () => {
        // Marked seen only once it has fully played (StrictMode's double effect run must not
        // swallow it in development).
        try {
          window.sessionStorage.setItem(SESSION_KEY, "1");
        } catch {
          // Blocked storage: it simply shows again next time.
        }
        setState("gone");
        onDone();
      },
      reduced ? 350 : 2500,
    );
    return () => {
      clearTimeout(leave);
      clearTimeout(done);
    };
    // Mount-only on purpose: re-running on a new `onDone` identity would replay the splash.
  }, []);

  if (state === "checking" || state === "gone") return null;

  return (
    <div
      aria-hidden="true"
      data-testid="entrance-intro"
      className={`fixed inset-0 z-[90] grid place-items-center bg-[radial-gradient(circle_at_50%_45%,#6d28d9,#14062b_70%)] transition-opacity duration-500 ${
        state === "leaving" ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <div className="grid justify-items-center gap-2">
        <CandyIcon
          name="crown"
          className="h-28 w-28 animate-[qr-drop_.8s_cubic-bezier(.3,1.6,.5,1)_both] drop-shadow-[0_10px_20px_rgba(0,0,0,0.4)]"
        />
        <p className="animate-[qr-rise_.6s_.55s_ease_both] font-display text-5xl font-semibold text-ink sm:text-6xl">
          Queen<span className="text-gc">Royal</span>
        </p>
        <p className="animate-[qr-rise_.6s_.8s_ease_both] text-sm font-extrabold text-ink-mute">
          Welcome to the royal casino floor
        </p>
      </div>
    </div>
  );
}
