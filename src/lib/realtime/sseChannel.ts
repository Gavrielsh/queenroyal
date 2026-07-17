import type { ChannelStatus, WalletChannel } from "@/lib/realtime/walletChannel";
import { logEvent } from "@/lib/telemetry";

/**
 * EventSource-backed WalletChannel with a survival envelope for the real world.
 *
 *  - HEARTBEAT WATCHDOG: the browser's `onerror` misses silent drops (half-open TCP, dead
 *    proxies), so a client-side watchdog expects SERVER heartbeats (`event: heartbeat`, a
 *    named event — SSE comments never reach page script). Every received event re-arms it;
 *    silence past the budget terminates and recycles the connection manually.
 *  - JITTERED EXPONENTIAL BACKOFF (thundering-herd protection): when the gateway restarts
 *    and drops every connection at once, clients must not stampede back in lockstep.
 *    Reconnect delay = raw/2 + jitter()·raw/2 where raw = min(cap, base·2^(attempt-1))
 *    (AWS "equal jitter"): a strict exponential floor with a randomized half. Native
 *    EventSource auto-retry is deliberately disabled by closing on error — this module owns
 *    ALL reconnect timing.
 *  - OPAQUE EVENTS (single source of truth): wallet notifications carry no payload into the
 *    app. The handlers never read `event.data` — grep-enforced in the DoD — so no money
 *    byte can enter through this transport; consumers get a bare "changed" signal and the
 *    validated fetch path does the rest.
 */

export interface SseChannelOptions {
  /** Silence budget before the watchdog recycles the connection (server pings ~15-30s). */
  heartbeatTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** DI seams for deterministic tests. */
  eventSourceFactory?: (url: string) => EventSource;
  jitter?: () => number;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 30_000;

export function createSseWalletChannel(url: string, options: SseChannelOptions = {}): WalletChannel {
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const eventSourceFactory = options.eventSourceFactory ?? ((target: string) => new EventSource(target));
  const jitter = options.jitter ?? Math.random;

  let source: EventSource | null = null;
  let status: ChannelStatus = "closed";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const statusSubscribers = new Set<(next: ChannelStatus) => void>();
  const walletSubscribers = new Set<() => void>();

  function setStatus(next: ChannelStatus): void {
    if (status === next) return;
    status = next;
    for (const subscriber of statusSubscribers) {
      try {
        subscriber(next);
      } catch {
        // A consumer fault must never break the transport for other listeners.
      }
    }
  }

  function notifyWallet(): void {
    for (const subscriber of walletSubscribers) {
      try {
        subscriber();
      } catch {
        // Same throw-safety as above.
      }
    }
  }

  function clearWatchdog(): void {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function clearReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** Close + nullify the current EventSource without touching reconnect plans. */
  function teardownSource(): void {
    clearWatchdog();
    if (source) {
      source.close();
      source = null;
    }
  }

  function armWatchdog(): void {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      logEvent("wallet.realtime.disconnected", { reason: "heartbeat_timeout" });
      teardownSource();
      setStatus("degraded");
      scheduleReconnect();
    }, heartbeatTimeoutMs);
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectAttempt += 1;
    const raw = Math.min(backoffCapMs, backoffBaseMs * 2 ** (reconnectAttempt - 1));
    const delay = Math.floor(raw / 2 + jitter() * (raw / 2));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open(): void {
    teardownSource();
    setStatus(reconnectAttempt === 0 ? "connecting" : "degraded");
    const next = eventSourceFactory(url);
    source = next;

    next.onopen = () => {
      reconnectAttempt = 0;
      logEvent("wallet.realtime.connected", {});
      setStatus("healthy");
      armWatchdog();
    };

    next.onerror = () => {
      // Native auto-retry has no backoff control: take over entirely.
      logEvent("wallet.realtime.disconnected", { reason: "error" });
      teardownSource();
      setStatus("degraded");
      scheduleReconnect();
    };

    // Server heartbeat — feeds the watchdog only. The payload is never read.
    next.addEventListener("heartbeat", () => {
      armWatchdog();
    });

    // Wallet-changed notification — OPAQUE by contract: no payload is read, ever; the
    // subscribers receive a bare signal and the validated fetch path owns the money.
    next.addEventListener("wallet", () => {
      armWatchdog();
      notifyWallet();
    });
  }

  return {
    connect(): void {
      if (source !== null || reconnectTimer !== null) return; // idempotent while live/pending
      reconnectAttempt = 0;
      open();
    },

    close(): void {
      clearReconnect();
      teardownSource();
      reconnectAttempt = 0;
      setStatus("closed");
    },

    onStatus(subscriber: (next: ChannelStatus) => void): () => void {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },

    onWalletEvent(subscriber: () => void): () => void {
      walletSubscribers.add(subscriber);
      return () => {
        walletSubscribers.delete(subscriber);
      };
    },

    getStatus(): ChannelStatus {
      return status;
    },
  };
}
