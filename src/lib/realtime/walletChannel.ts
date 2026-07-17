import { createSseWalletChannel } from "@/lib/realtime/sseChannel";

/**
 * The realtime wallet channel — interface, feature flag, and app singleton (M4 Phase B).
 *
 * SINGLE SOURCE OF TRUTH CONTRACT: the channel delivers OPAQUE "the wallet may have
 * changed" notifications and connection status — nothing else. It never carries, parses,
 * or exposes money payloads; every byte of financial data still enters the app through the
 * one validated React Query fetch path. Realtime is a faster invalidation signal, never a
 * second writer.
 *
 * FEATURE FLAG: the transport exists only when NEXT_PUBLIC_WALLET_CHANNEL_URL is set. Flag
 * unset ⇒ getWalletChannel() returns null and no realtime code runs — the app remains
 * exactly the battle-tested Phase A polling system.
 *
 * CROSS-ZONE CONTRACT (Zone 2 backlog, documented not assumed): the endpoint must emit
 * `event: heartbeat` at least every ~15-30s (a NAMED event — SSE comments are invisible to
 * page script and cannot feed the watchdog) and `event: wallet` on any balance-affecting
 * settlement. EventSource cannot send an Authorization header, so the endpoint must accept
 * a cookie or a short-lived signed ticket.
 */

/** Connection status the policy layer (M4-T6) keys off. */
export type ChannelStatus = "connecting" | "healthy" | "degraded" | "closed";

export interface WalletChannel {
  /** Open (or re-open) the stream. Idempotent while open or while a reconnect is pending. */
  connect(): void;
  /** User-initiated shutdown: closes the stream, cancels reconnects, nullifies references. */
  close(): void;
  /** Subscribe to status transitions. Returns unsubscribe. Throw-safe. */
  onStatus(subscriber: (status: ChannelStatus) => void): () => void;
  /** Subscribe to opaque wallet-changed notifications (NO payload). Returns unsubscribe. */
  onWalletEvent(subscriber: () => void): () => void;
  getStatus(): ChannelStatus;
}

export function walletChannelUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_WALLET_CHANNEL_URL;
  return url !== undefined && url.length > 0 ? url : null;
}

export function isWalletChannelEnabled(): boolean {
  return walletChannelUrl() !== null;
}

let singleton: WalletChannel | null = null;

/** The one channel per browser session, or null when the feature flag is unset. */
export function getWalletChannel(): WalletChannel | null {
  const url = walletChannelUrl();
  if (url === null) return null;
  if (singleton === null) singleton = createSseWalletChannel(url);
  return singleton;
}
