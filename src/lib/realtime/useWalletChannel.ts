"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { getWalletChannel } from "@/lib/realtime/walletChannel";
import { useWalletChannelLifecycle } from "@/lib/realtime/useWalletChannelLifecycle";
import { invalidateWalletBalances } from "@/lib/walletInvalidate";

/**
 * Push-to-invalidate integration (M4-T5) — the ONLY consumer of the wallet channel.
 *
 * SINGLE SOURCE OF TRUTH: a realtime signal never carries money. Both signal kinds — an
 * opaque `wallet` notification and every entry into `healthy` (initial connect AND each
 * reconnect = the catch-up for anything missed while blind) — funnel into ONE action: the
 * shared choke-point invalidation with trigger "realtime". The cache's writer set is
 * unchanged: the validated fetch path remains the only thing that ever writes balances
 * (`setQueryData` appears nowhere in this codebase — grep-enforced in the DoD).
 *
 * COALESCING: a provider settling a burst of spins must not hammer the gateway. Signals are
 * debounced trailing-edge (DEBOUNCE_MS after the last signal), with a MAX_COALESCE_MS
 * ceiling so a CONTINUOUS event stream can never starve invalidation — under sustained
 * events the app still re-reads at least once per ceiling window.
 */

export const REALTIME_INVALIDATE_DEBOUNCE_MS = 250;
export const REALTIME_MAX_COALESCE_MS = 1_000;

export function useWalletChannel(): void {
  useWalletChannelLifecycle(); // StrictMode-immune connect/close (no-op when the flag is unset)
  const queryClient = useQueryClient();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSinceRef = useRef<number | null>(null);

  useEffect(() => {
    const channel = getWalletChannel();
    if (channel === null) return undefined; // flag unset: Phase A polling remains the system

    const flush = (): void => {
      debounceTimerRef.current = null;
      pendingSinceRef.current = null;
      void invalidateWalletBalances(queryClient, "realtime");
    };

    const scheduleInvalidate = (): void => {
      const now = Date.now();
      if (pendingSinceRef.current === null) pendingSinceRef.current = now;
      const alreadyWaiting = now - pendingSinceRef.current;
      const wait = Math.min(
        REALTIME_INVALIDATE_DEBOUNCE_MS,
        Math.max(0, REALTIME_MAX_COALESCE_MS - alreadyWaiting),
      );
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(flush, wait);
    };

    const unsubscribeWallet = channel.onWalletEvent(scheduleInvalidate);
    const unsubscribeStatus = channel.onStatus((status) => {
      // CATCH-UP: every arrival at healthy means we may have been blind — re-read.
      if (status === "healthy") scheduleInvalidate();
    });

    return () => {
      unsubscribeWallet();
      unsubscribeStatus();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingSinceRef.current = null;
    };
  }, [queryClient]);
}
