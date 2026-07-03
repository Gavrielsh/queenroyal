import { logEvent } from "@/lib/telemetry";

/**
 * Cross-tab attempt-token retention for the cashier (deterministic idempotency, client half).
 *
 * A LOGICAL purchase (keyed by `packageId`) gets exactly ONE attempt token: minted on the
 * first attempt, REUSED across user-driven retries — including retries from another tab —
 * and rotated only when the attempt reaches a terminal outcome (`markSettled` /
 * `markAbandoned`). The token anchors both the PSP intent and the ledger credit, so a retry
 * can never double-charge or double-credit.
 *
 * Authority model: this module is a BEST-EFFORT UX cache, never the authority. The gateway's
 * get-or-create semantics over `(user, packageId, attemptToken)` are what durably converge
 * retries across devices and cleared storage; losing this cache costs convenience, not money.
 *
 * Storage layers (top wins; every layer optional and guarded — this module NEVER throws into
 * the money flow):
 *   1. In-memory `Map` — always available, retry-safe within the tab.
 *   2. `localStorage` (`qr_purchase_attempt:{packageId}`) — survives reloads and new tabs.
 *   3. `BroadcastChannel("qr-purchase")` — live peer protocol; `storage` events double as
 *      an adoption/fallback signal where the channel is unavailable.
 *
 * Peer protocol: tabs post `{ packageId, state }`. Terminal states (`settled`/`abandoned`,
 * or the fallback-only `cleared`) drop every tab's copy so the next purchase mints fresh.
 * The `in_flight`/`released` states are typed here but posted by the purchase flow (M2-T2)
 * to drive cross-tab Buy-button locking.
 *
 * FinTech logging rule: the token VALUE is opaque and never appears in telemetry, errors, or
 * broadcasts' logs — events carry the `packageId` only.
 */

/**
 * Brand for provenance: a raw string/UUID cannot be passed where an AttemptToken is required,
 * so only tokens that went through this module's retention lifecycle reach the wire
 * (compiler-enforced at the apiClient boundary in M2-T3).
 */
export type AttemptToken = string & { readonly __brand: "AttemptToken" };

const PEER_STATES = ["in_flight", "released", "settled", "abandoned", "cleared"] as const;

/** Cross-tab purchase activity. `cleared` is the storage-fallback terminal (outcome unknown). */
export type PeerPurchaseState = (typeof PEER_STATES)[number];

export interface PeerPurchaseEvent {
  packageId: string;
  state: PeerPurchaseState;
}

const STORAGE_PREFIX = "qr_purchase_attempt:";
const CHANNEL_NAME = "qr-purchase";

const memoryTokens = new Map<string, AttemptToken>();
/**
 * Packages whose terminal clear could NOT remove the persisted token (removeItem threw).
 * A tombstone hides the stale stored value from reads so a SPENT idempotency token can never
 * be resurrected into a new purchase — the false-dedupe failure mode. Cleared when a fresh
 * mint or a peer's overwrite supersedes the stale entry.
 */
const clearedTombstones = new Set<string>();
const listeners = new Set<(event: PeerPurchaseEvent) => void>();

let channel: BroadcastChannel | null = null;
let wired = false;

/**
 * The single branding site: every AttemptToken in the system originates here — either freshly
 * minted or re-adopted from the persistence/peer layer this module itself wrote.
 */
function brandToken(value: string): AttemptToken {
  return value as AttemptToken;
}

function mintTokenValue(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  // Legacy-engine fallback: 128 bits of entropy, hex-encoded. Idempotency tokens are opaque
  // references (the server scopes them per user), not secrets — collision resistance is what
  // matters, and 128 random bits provide it.
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function storageKey(packageId: string): string {
  return `${STORAGE_PREFIX}${packageId}`;
}

function readStoredToken(packageId: string): AttemptToken | null {
  if (!hasWindow()) return null;
  try {
    const value = window.localStorage.getItem(storageKey(packageId));
    return value ? brandToken(value) : null;
  } catch {
    return null; // Private mode / storage disabled — memory carries the attempt.
  }
}

function writeStoredToken(packageId: string, token: AttemptToken): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(storageKey(packageId), token);
  } catch {
    // Quota / private mode — the in-memory layer keeps this tab retry-safe.
  }
}

/** Remove the persisted token; false means a stale copy may linger (caller tombstones it). */
function clearStoredToken(packageId: string): boolean {
  if (!hasWindow()) return true; // nothing persisted in this environment
  try {
    window.localStorage.removeItem(storageKey(packageId));
    return true;
  } catch {
    return false;
  }
}

function parsePeerEvent(data: unknown): PeerPurchaseEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.packageId !== "string" || record.packageId.length === 0) return null;
  const state = PEER_STATES.find((candidate) => candidate === record.state);
  if (!state) return null;
  return { packageId: record.packageId, state };
}

function notifyListeners(event: PeerPurchaseEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A consumer fault must never break the channel for other listeners.
    }
  }
}

function handlePeerEvent(event: PeerPurchaseEvent): void {
  // Terminal peer outcomes drop our copy so the NEXT purchase mints fresh everywhere.
  if (event.state === "settled" || event.state === "abandoned" || event.state === "cleared") {
    memoryTokens.delete(event.packageId);
    if (!clearStoredToken(event.packageId)) {
      clearedTombstones.add(event.packageId); // stale persisted copy must not be re-adopted
    }
  }
  notifyListeners(event);
}

function onStorageEvent(event: StorageEvent): void {
  if (!event.key || !event.key.startsWith(STORAGE_PREFIX)) return;
  const packageId = event.key.slice(STORAGE_PREFIX.length);

  if (event.newValue === null) {
    // A peer tab cleared the attempt. With a live BroadcastChannel the richer protocol
    // message already handled it — only keep memory consistent here to avoid a double
    // notification; without a channel this IS the (terminal-outcome-unknown) signal.
    if (channel === null) {
      handlePeerEvent({ packageId, state: "cleared" });
    } else {
      memoryTokens.delete(packageId);
    }
    return;
  }

  // A peer tab minted or overwrote the attempt — adopt it so every tab retries with the
  // SAME token (last writer wins consistently across the origin). A fresh write supersedes
  // any tombstone: the stale entry it was hiding has just been overwritten.
  clearedTombstones.delete(packageId);
  memoryTokens.set(packageId, brandToken(event.newValue));
}

function ensureWired(): void {
  if (wired || !hasWindow()) return;
  wired = true;

  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const peer = parsePeerEvent(event.data);
        if (peer) handlePeerEvent(peer);
      };
    }
  } catch {
    channel = null; // No channel — storage events remain as the fallback signal.
  }

  try {
    window.addEventListener("storage", onStorageEvent);
  } catch {
    // Without storage events, memory + localStorage reads still converge lazily.
  }
}

function broadcast(event: PeerPurchaseEvent): void {
  if (!channel) return;
  try {
    channel.postMessage(event);
    logEvent("purchase.tab.broadcast", { packageId: event.packageId, state: event.state });
  } catch {
    // A broken channel must never break the money flow.
  }
}

/**
 * Return the attempt token for this logical purchase, minting one only if no tab holds one.
 * Reuse (memory or cross-tab storage) is the money-critical path: a retry MUST reach the
 * gateway with the same token the failed attempt used.
 */
export function getOrCreateAttemptToken(packageId: string): AttemptToken {
  ensureWired();

  const inMemory = memoryTokens.get(packageId);
  if (inMemory) {
    logEvent("purchase.token.reused", { packageId, source: "memory" });
    return inMemory;
  }

  // A tombstoned package's persisted token is SPENT — reusing it would false-dedupe the
  // next purchase against an already-settled intent. Skip storage and mint fresh.
  const stored = clearedTombstones.has(packageId) ? null : readStoredToken(packageId);
  if (stored) {
    memoryTokens.set(packageId, stored);
    logEvent("purchase.token.reused", { packageId, source: "storage" });
    return stored;
  }

  const minted = brandToken(mintTokenValue());
  memoryTokens.set(packageId, minted);
  writeStoredToken(packageId, minted);
  clearedTombstones.delete(packageId); // the fresh token supersedes any stale entry
  logEvent("purchase.token.minted", { packageId });
  return minted;
}

/** Read the current token without minting or emitting — a pure, side-effect-free probe. */
export function peekAttemptToken(packageId: string): AttemptToken | null {
  ensureWired();
  const inMemory = memoryTokens.get(packageId);
  if (inMemory) return inMemory;
  return clearedTombstones.has(packageId) ? null : readStoredToken(packageId);
}

function clearAttempt(packageId: string, outcome: "settled" | "abandoned"): void {
  ensureWired();

  const hadMemory = memoryTokens.delete(packageId);
  const hadStored = !clearedTombstones.has(packageId) && readStoredToken(packageId) !== null;
  if (!clearStoredToken(packageId)) {
    clearedTombstones.add(packageId); // stale persisted copy must not be re-adopted
  }
  if (!hadMemory && !hadStored) return; // double-settle / unknown package: a quiet no-op

  logEvent("purchase.token.cleared", { packageId, outcome });
  broadcast({ packageId, state: outcome });
}

/** Terminal success: the purchase settled — drop the token so the next purchase mints fresh. */
export function markSettled(packageId: string): void {
  clearAttempt(packageId, "settled");
}

/** Terminal failure (business decline etc.): the attempt is dead — rotate the token. */
export function markAbandoned(packageId: string): void {
  clearAttempt(packageId, "abandoned");
}

/**
 * Subscribe to peer-tab purchase activity (terminal outcomes now; `in_flight`/`released`
 * arrive with the M2-T2 purchase flow). Returns an unsubscribe function. Listener faults are
 * swallowed — a UI bug cannot break the retention protocol.
 */
export function onPeerActivity(listener: (event: PeerPurchaseEvent) => void): () => void {
  ensureWired();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
