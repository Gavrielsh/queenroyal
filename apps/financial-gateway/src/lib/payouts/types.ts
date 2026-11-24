/**
 * Payout rail abstraction — the last mile of money OUT.
 *
 * The worker depends on this interface, never on a concrete rail, so a real provider (Dwolla,
 * Trolley, a card-push processor, a cheque printer) drops in without touching the redemption
 * lifecycle. The shape mirrors lib/payments: an intent is submitted, and the terminal outcome
 * may arrive later.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AMOUNT IS A DECIMAL STRING. IT NEVER BECOMES A NUMBER.
 * ─────────────────────────────────────────────────────────────────────────────
 * The PSP interface takes `amountCents: number`, which is correct THERE because a card
 * processor's wire format is integer minor units. This interface deliberately does not copy
 * that. A payout amount originates as the exact decimal string the ledger debited, and the
 * moment it passes through a JS number the scale the ledger guaranteed is gone — a difference
 * nobody notices until someone is paid 124.99 instead of 125.00.
 *
 * A real rail that demands minor units converts at ITS OWN boundary, inside its adapter, and
 * must do so without floating point (see lib/money's exact integer helpers). That conversion is
 * the adapter's problem; it is not this interface's, and it is emphatically not the worker's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY IS PART OF THE CONTRACT, NOT AN OPTIMISATION
 * ─────────────────────────────────────────────────────────────────────────────
 * `redemptionId` is the idempotency key. An implementation MUST guarantee that two calls
 * carrying the same id result in AT MOST ONE payout, and that the second returns the first's
 * result. The worker relies on this: a retryable failure leaves it genuinely unsure whether
 * money moved, and re-sending is only safe because the rail promises this.
 */

/** A request to pay a player. Every monetary value is a decimal string. */
export interface PayoutRequest {
  /** The redemption's id — also the rail's idempotency key. */
  redemptionId: string;
  /** Our local user id, forwarded as the payee reference. */
  playerRef: string;
  /** Decimal string in whole units, ≤ 4 dp. NEVER a number. */
  amount: string;
  /** ISO 4217, e.g. "USD". */
  currency: string;
  /** Small string-valued metadata echoed back by the rail for correlation. */
  metadata?: Record<string, string>;
}

/**
 * Where a payout is.
 *   submitted — accepted by the rail, not yet settled. The money is in flight.
 *   paid      — settled. Terminal.
 *   failed    — the rail refused it terminally. Terminal.
 */
export type PayoutStatus = "submitted" | "paid" | "failed";

export interface PayoutResult {
  /** The rail's own reference. Stored on the redemption for correlation, never as money. */
  payoutRef: string;
  status: PayoutStatus;
  /** Present when the rail refused; surfaced to operators, never to the player verbatim. */
  failureReason?: string;
}

/** A point-in-time read, for resolving a payout whose submission we did not see complete. */
export interface PayoutSnapshot extends PayoutResult {
  redemptionId: string;
  amount: string;
}

/**
 * A rail failure with its retry disposition attached.
 *
 * `retryable` is the field the worker's safety depends on. Retryable means the rail did not
 * give a definite answer (timeout, 5xx, rate limit) — the payout may or may not have been
 * accepted, and the idempotency contract above is what makes another attempt safe. Terminal
 * means the rail gave a definite NO, so retrying cannot change the answer and doing it anyway
 * only burns the budget and delays the operator finding out.
 */
export class PayoutProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PayoutProviderError";
  }
}

export class PayoutProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutProviderNotConfiguredError";
  }
}

export interface PayoutProvider {
  /** Submit a payout. Idempotent on `redemptionId` — see the contract above. */
  sendPayout(req: PayoutRequest): Promise<PayoutResult>;
  /** Read a previously-submitted payout, or null if the rail has never seen this id. */
  retrievePayout(redemptionId: string): Promise<PayoutSnapshot | null>;
}
