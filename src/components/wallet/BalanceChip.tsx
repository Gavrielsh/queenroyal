"use client";

import { useEffect, useRef, useState } from "react";

import { formatBalance } from "@/lib/format";
import { CURRENCY_LABEL, CURRENCY_TEXT_CLASS, type CurrencyFamily } from "@/lib/theme";

/**
 * THE balance display primitive (shared by every window; previously duplicated per window).
 *
 * A pure consumer: engine decimal STRING in, pixels out. It never parses, computes, or
 * tweens money — the no-float law. Three states:
 *   value === null  → skeleton shimmer (an honest "not loaded", never a fabricated zero)
 *   stale           → last authoritative strings kept visible, dimmed + STALE badge
 *   value CHANGED   → one pulse-glow cycle, triggered strictly by string inequality
 *                     (prev !== next on the raw string; the first paint is not a change)
 */
export interface BalanceChipProps {
  family: CurrencyFamily;
  /** Engine decimal string, verbatim — or null before the first authoritative read. */
  value: string | null;
  /** Last sync failed: keep showing the last strings, dimmed and flagged. */
  stale?: boolean;
}

export function BalanceChip({ family, value, stale = false }: BalanceChipProps) {
  const [pulsing, setPulsing] = useState(false);
  const previousRef = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = value;
    // String inequality is the ONLY change detector — money is never parsed (no-float law).
    if (previous !== null && value !== null && previous !== value) {
      setPulsing(true);
      const timer = setTimeout(() => setPulsing(false), 1_500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [value]);

  const label = CURRENCY_LABEL[family];

  return (
    <div
      className={`rounded-chip border border-edge bg-surface-2/70 px-2 py-2 text-center transition ${
        stale ? "opacity-60" : ""
      }`}
    >
      <p className="flex items-center justify-center gap-1.5 text-[9px] uppercase tracking-wider text-ink-faint">
        {label}
        {stale && (
          <span className="rounded-full bg-stale/15 px-1.5 py-px text-[8px] font-black tracking-wider text-stale">
            STALE
          </span>
        )}
      </p>
      {value === null ? (
        <div
          role="status"
          aria-label={`Loading ${label} balance`}
          data-testid="balance-skeleton"
          className="mx-auto mt-1.5 h-4 w-14 animate-shimmer rounded bg-surface-3 bg-[linear-gradient(90deg,transparent,rgba(244,244,246,0.14),transparent)] bg-[length:200%_100%]"
        />
      ) : (
        <p
          data-testid="balance-value"
          className={`truncate text-sm font-bold tabular-nums ${CURRENCY_TEXT_CLASS[family]} ${
            pulsing ? "animate-pulse-glow drop-shadow-[0_0_10px_currentColor]" : ""
          }`}
        >
          {formatBalance(value)}
        </p>
      )}
    </div>
  );
}
