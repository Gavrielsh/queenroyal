"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The unified action-feedback system (extracted from the per-window toast duplicates).
 *
 * Policy — the money-UI rule this component enforces:
 *   - SUCCESS notices auto-dismiss (4s): confirmation is transient by nature.
 *   - ERROR notices PERSIST until explicitly dismissed: a player must never miss a failed
 *     money action because they glanced away for four seconds.
 *
 * A new notice replaces the current one (and cancels its pending auto-dismiss). The
 * container keeps `role="alert"` — this is THE alert channel for user actions; passive sync
 * state deliberately lives in WalletStatusBanner as `role="status"` so failures are announced
 * exactly once.
 */
export interface Notice {
  /**
   * `success` is the CELEBRATORY styling (green, success ring) and auto-dismisses.
   *
   * GATE C: it is reserved for a round the engine classified WIN. A round that
   * settled correctly but returned the stake exactly is a `neutral` notice — it
   * happened, it is worth stating, and it is not an achievement. Reaching for
   * `success` because "the request succeeded" is how a loss disguised as a win
   * gets shipped in the copy.
   */
  kind: "error" | "success" | "neutral";
  message: string;
}

const SUCCESS_DISMISS_MS = 4_000;

export interface ActionNoticeController {
  notice: Notice | null;
  showNotice: (next: Notice) => void;
  dismissNotice: () => void;
}

export function useActionNotice(): ActionNoticeController {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismissNotice = useCallback(() => {
    clearTimer();
    setNotice(null);
  }, [clearTimer]);

  const showNotice = useCallback(
    (next: Notice) => {
      clearTimer();
      setNotice(next);
      if (next.kind === "success" || next.kind === "neutral") {
        timerRef.current = setTimeout(() => setNotice(null), SUCCESS_DISMISS_MS);
      }
      // Errors arm no timer — they persist until the player dismisses them.
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { notice, showNotice, dismissNotice };
}

export function ActionNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  if (!notice) return null;
  const isError = notice.kind === "error";

  // Three distinct treatments. `neutral` deliberately does NOT borrow the success
  // palette: green-on-success is the visual claim "you gained", and a
  // stake-returning round has not.
  const tone =
    isError
      ? "text-danger ring-danger/40"
      : notice.kind === "success"
        ? "text-success ring-success/40"
        : "text-muted ring-edge-strong";

  return (
    <div
      role="alert"
      data-notice-kind={notice.kind}
      className={`absolute inset-x-6 -bottom-16 z-10 flex animate-settle-pop items-center justify-center gap-3 rounded-chip bg-surface-2/95 px-4 py-3 text-center text-sm font-semibold shadow-lift ring-1 backdrop-blur-md ${tone}`}
    >
      <span className="min-w-0 flex-1">{notice.message}</span>
      {isError && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="-my-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xs font-black text-danger transition hover:bg-danger/10"
        >
          <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full border border-danger/40">
            ✕
          </span>
        </button>
      )}
    </div>
  );
}
