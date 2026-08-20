import { logEvent } from "@/lib/telemetry";

/**
 * Per-attempt idempotency tokens for the spin flow (deterministic idempotency, client half).
 *
 * A spin ATTEMPT (keyed by `gameId`) gets exactly one token: minted when the player commits to
 * a spin, REUSED for every retry of that same attempt, and rotated only when the attempt
 * reaches a terminal outcome. The gateway derives the engine's `operator_transaction_id` from
 * it as `spin:<token>` (apps/financial-gateway/src/services/spin.service.ts), so the token is
 * what makes a retry converge on the ORIGINAL round instead of drawing a new one.
 *
 * ── WHY THE RETAIN/ROTATE SPLIT IS MONEY-CRITICAL ──────────────────────────────────────────
 *
 * A timeout or a 5xx does NOT mean the spin failed. The engine may have committed both ledger
 * legs and lost the response on the way back — the "ghost spin". Retrying with the SAME token
 * makes the engine's 23505 recovery path reconstruct and replay that committed outcome without
 * re-deducting. Retrying with a FRESH token would draw a second round and debit the player
 * twice. So:
 *
 *   retryable fault / auth lapse / still-in-flight  → RETAIN  (the round's fate is unknown)
 *   settled / business decline that wrote nothing   → ROTATE  (the question is answered)
 *
 * ── WHY THIS IS MEMORY-ONLY (unlike purchaseIntent) ────────────────────────────────────────
 *
 * `purchaseIntent` persists to localStorage and gossips over BroadcastChannel because a card
 * charge must survive a reload and must not double-charge from a second tab. A spin is a
 * tab-local, sub-second interaction with no external payment instrument: there is no
 * "resume my spin on another device" expectation to serve, and persisting a spent spin token
 * across reloads would add a false-dedupe surface (a stale token silently ghost-recovering an
 * old round) for no benefit. Losing this cache costs a retry's dedupe, never money — the
 * gateway's attempt-anchor gate and the engine's dedup table remain the durable authority.
 *
 * FinTech logging rule: the token VALUE is opaque and never appears in telemetry or errors —
 * events carry the `gameId` only.
 */

/**
 * Brand for provenance: a raw string cannot be passed where a SpinAttemptToken is required, so
 * only tokens that went through this module's lifecycle can reach the wire (enforced at the
 * apiClient boundary by `submitSpin`).
 */
export type SpinAttemptToken = string & { readonly __brand: "SpinAttemptToken" };

/** Terminal outcomes that rotate the token. */
export type SpinAttemptOutcome = "settled" | "abandoned";

const attempts = new Map<string, SpinAttemptToken>();

/** The single branding site: every SpinAttemptToken in the system originates here. */
function brandToken(value: string): SpinAttemptToken {
  return value as SpinAttemptToken;
}

/**
 * Mint 128 bits of entropy as an opaque reference. `randomUUID` where available; a hex-encoded
 * `getRandomValues` buffer otherwise (older engines, and jsdom builds without randomUUID).
 * Collision resistance is what matters — the token is not a secret, and the gateway scopes it
 * per player before it can anchor anything.
 *
 * The gateway's schema requires 8–200 characters (spin.schema.ts); both forms are 32–36.
 */
function mintTokenValue(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Return the live token for this game's in-flight attempt, minting one only if no attempt is
 * open. Reuse is the money-critical path: a retry MUST reach the gateway with the token the
 * failed attempt used.
 */
export function getOrCreateSpinAttempt(gameId: string): SpinAttemptToken {
  const existing = attempts.get(gameId);
  if (existing) {
    logEvent("spin.token.reused", { gameId });
    return existing;
  }
  const minted = brandToken(mintTokenValue());
  attempts.set(gameId, minted);
  logEvent("spin.token.minted", { gameId });
  return minted;
}

/** Read the current token without minting or emitting — a pure, side-effect-free probe. */
export function peekSpinAttempt(gameId: string): SpinAttemptToken | null {
  return attempts.get(gameId) ?? null;
}

function clearAttempt(gameId: string, outcome: SpinAttemptOutcome): void {
  if (!attempts.delete(gameId)) return; // double-settle / unknown game: a quiet no-op
  logEvent("spin.token.cleared", { gameId, outcome });
}

/** Terminal success: the round settled at the ledger — the next spin mints fresh. */
export function markSpinSettled(gameId: string): void {
  clearAttempt(gameId, "settled");
}

/**
 * Terminal rejection: the gateway or engine refused the attempt WITHOUT writing to the ledger
 * (insufficient funds, unknown game, validation). The anchor was never consumed, so the next
 * spin mints fresh rather than pointlessly replaying a dead key.
 */
export function markSpinAbandoned(gameId: string): void {
  clearAttempt(gameId, "abandoned");
}

/**
 * NON-terminal: the attempt's fate is unknown (timeout, 5xx, 409-still-processing) or blocked
 * on something recoverable (401). The token is RETAINED so the retry ghost-recovers the
 * original round. Deliberately a no-op with an explicit name — calling it documents at the
 * call site that retention was a decision, not an omission.
 */
export function markSpinRetained(_gameId: string): void {
  // Intentionally empty: retention IS the absence of a rotation.
}

/**
 * TEST-ONLY: drop all in-flight attempts. The map is module-level state; a leaked token would
 * bleed one test's idempotency key into the next. Never called by application code.
 */
export function __resetSpinAttempts(): void {
  attempts.clear();
}
