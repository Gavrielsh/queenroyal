import { logEvent } from "@/lib/telemetry";

/**
 * Per-attempt idempotency token for the redemption flow (deterministic idempotency, client
 * half) — the redemption analogue of spinIntent.ts.
 *
 * There is exactly one redemption FORM on the page, so unlike spinIntent (keyed per game) or
 * purchaseIntent (keyed per package, cross-tab), this module holds a single slot: one token
 * minted when the player commits to a redemption attempt, REUSED for every retry of that same
 * attempt, and rotated only when the attempt reaches a terminal outcome. The gateway derives
 * `operator_transaction_id` from it as `redeem:<token>`
 * (apps/financial-gateway/src/services/redemption.service.ts), so the token is what makes a
 * retry converge on the ORIGINAL debit instead of moving money twice.
 *
 * ── WHY THE RETAIN/ROTATE SPLIT IS MONEY-CRITICAL ──────────────────────────────────────────
 *
 * A timeout or a 5xx does NOT mean the redemption failed. The engine may have committed the
 * debit and lost the response on the way back. Retrying with the SAME token makes the engine's
 * dedup path reconstruct and replay that committed outcome without debiting twice. Retrying
 * with a FRESH token would debit a second time. So:
 *
 *   retryable fault / auth lapse / still-in-flight  → RETAIN  (the debit's fate is unknown)
 *   settled / business refusal that wrote nothing   → ROTATE  (the question is answered)
 *
 * ── WHY THIS IS MEMORY-ONLY (like spinIntent, unlike purchaseIntent) ───────────────────────
 *
 * A redemption request is a single gateway call with no external payment instrument to resume
 * across a reload — there is no "confirm this on another tab" step. Losing this cache on
 * reload costs a retry's dedupe, never money — the gateway's attempt-anchor gate and the
 * engine's dedup table remain the durable authority.
 *
 * FinTech logging rule: the token VALUE is opaque and never appears in telemetry or errors.
 */

/** Brand for provenance: only a token that went through this lifecycle can reach the wire. */
export type RedemptionAttemptToken = string & { readonly __brand: "RedemptionAttemptToken" };

/** Terminal outcomes that rotate the token. */
export type RedemptionAttemptOutcome = "settled" | "abandoned";

let currentAttempt: RedemptionAttemptToken | null = null;

function brandToken(value: string): RedemptionAttemptToken {
  return value as RedemptionAttemptToken;
}

/**
 * Mint 128 bits of entropy as an opaque reference. `randomUUID` where available; a hex-encoded
 * `getRandomValues` buffer otherwise (older engines, jsdom builds without randomUUID). The
 * gateway's schema requires 8–200 characters (redeem.schema.ts); both forms are 32–36.
 */
function mintTokenValue(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Return the live token for the in-flight attempt, minting one only if none is open. Reuse is
 * the money-critical path: a retry MUST reach the gateway with the token the failed attempt
 * used.
 */
export function getOrCreateRedemptionAttempt(): RedemptionAttemptToken {
  if (currentAttempt) {
    logEvent("redemption.token.reused", {});
    return currentAttempt;
  }
  currentAttempt = brandToken(mintTokenValue());
  logEvent("redemption.token.minted", {});
  return currentAttempt;
}

/** Read the current token without minting or emitting — a pure, side-effect-free probe. */
export function peekRedemptionAttempt(): RedemptionAttemptToken | null {
  return currentAttempt;
}

function clearAttempt(outcome: RedemptionAttemptOutcome): void {
  if (currentAttempt === null) return; // double-settle: a quiet no-op
  currentAttempt = null;
  logEvent("redemption.token.cleared", { outcome });
}

/** Terminal success: the redemption debited at the ledger — the next attempt mints fresh. */
export function markRedemptionSettled(): void {
  clearAttempt("settled");
}

/**
 * Terminal refusal: the gateway or engine refused the attempt WITHOUT writing to the ledger
 * (below minimum, KYC required, jurisdiction closed, validation). The anchor was never
 * consumed, so the next attempt mints fresh rather than replaying a dead key.
 */
export function markRedemptionAbandoned(): void {
  clearAttempt("abandoned");
}

/**
 * NON-terminal: the attempt's fate is unknown (timeout, 5xx, 409-still-processing) or blocked
 * on something recoverable (401). The token is RETAINED so the retry ghost-recovers the
 * original debit. Deliberately a no-op with an explicit name — calling it documents at the
 * call site that retention was a decision, not an omission.
 */
export function markRedemptionRetained(): void {
  // Intentionally empty: retention IS the absence of a rotation.
}

/**
 * TEST-ONLY: drop the in-flight attempt. Module-level state; a leaked token would bleed one
 * test's idempotency key into the next. Never called by application code.
 */
export function __resetRedemptionAttempts(): void {
  currentAttempt = null;
}
