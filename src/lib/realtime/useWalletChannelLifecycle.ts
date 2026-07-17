"use client";

import { useEffect } from "react";

import { getWalletChannel } from "@/lib/realtime/walletChannel";

/**
 * Mounts the app's wallet-channel connection with React 18 StrictMode immunity.
 *
 * StrictMode (dev) runs every effect as mount → cleanup → mount. A naive connect/close pair
 * would open, kill, and re-open a REAL gateway connection on every mount — churn upstream
 * and a reconnect storm downstream. This hook ref-counts consumers and defers the final
 * close by one tick: the immediate StrictMode remount reclaims the SAME connection (zero
 * churn), while a genuine last unmount lets the timer fire, which closes the stream and
 * nullifies its references inside the channel (zero leaks).
 *
 * Feature-flag behavior: with NEXT_PUBLIC_WALLET_CHANNEL_URL unset, getWalletChannel()
 * returns null and this hook does nothing at all — Phase A polling remains the system.
 */

let consumerCount = 0;
let pendingRelease: ReturnType<typeof setTimeout> | null = null;

export function useWalletChannelLifecycle(): void {
  useEffect(() => {
    const channel = getWalletChannel();
    if (channel === null) return undefined; // flag unset: zero realtime behavior

    consumerCount += 1;
    if (pendingRelease) {
      // A remount (StrictMode, or another consumer) reclaims the connection before the
      // deferred close fires — cancel it.
      clearTimeout(pendingRelease);
      pendingRelease = null;
    }
    channel.connect(); // idempotent while live or reconnect-pending

    return () => {
      consumerCount -= 1;
      if (consumerCount > 0) return;
      pendingRelease = setTimeout(() => {
        pendingRelease = null;
        if (consumerCount === 0) channel.close();
      }, 0);
    };
  }, []);
}
