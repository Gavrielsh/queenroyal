import { randomUUID } from "node:crypto";

import { isPositiveMoneyString } from "../money";
import {
  type PayoutProvider,
  PayoutProviderError,
  type PayoutRequest,
  type PayoutResult,
  type PayoutSnapshot,
} from "./types";

/**
 * In-memory payout rail for development and tests.
 *
 * It is a real implementation of the contract, not a stub that always says yes: it enforces
 * idempotency on `redemptionId`, validates the amount as a decimal string, and can be told to
 * fail in either disposition so the worker's retry and dead-letter paths are exercised against
 * something that behaves like a rail.
 *
 * FORBIDDEN IN PRODUCTION (see index.ts). A mock that reports `paid` without moving money would
 * mark redemptions as settled that no player ever received.
 */
export class MockPayoutProvider implements PayoutProvider {
  private readonly sent = new Map<string, PayoutSnapshot>();
  /** Programmed failures, keyed by redemptionId. */
  private readonly faults = new Map<string, PayoutProviderError>();
  /** When set, the next submission returns `submitted` rather than settling immediately. */
  private pendingIds = new Set<string>();

  async sendPayout(req: PayoutRequest): Promise<PayoutResult> {
    // The amount arrives as a decimal string and is validated as one. A number would already
    // have failed the type, and this catches a malformed string before a real rail would.
    if (!isPositiveMoneyString(req.amount)) {
      throw new PayoutProviderError("INVALID_AMOUNT", `not a positive money string: ${req.amount}`, false);
    }

    // IDEMPOTENCY: a repeat of the same id returns the ORIGINAL result and sends nothing new.
    const existing = this.sent.get(req.redemptionId);
    if (existing) return { payoutRef: existing.payoutRef, status: existing.status };

    const fault = this.faults.get(req.redemptionId);
    if (fault) throw fault;

    const snapshot: PayoutSnapshot = {
      redemptionId: req.redemptionId,
      payoutRef: `payout_${randomUUID()}`,
      // The amount is stored back verbatim — the rail never reformats it.
      amount: req.amount,
      status: this.pendingIds.has(req.redemptionId) ? "submitted" : "paid",
    };
    this.sent.set(req.redemptionId, snapshot);
    return { payoutRef: snapshot.payoutRef, status: snapshot.status };
  }

  async retrievePayout(redemptionId: string): Promise<PayoutSnapshot | null> {
    return this.sent.get(redemptionId) ?? null;
  }

  // ── Test/dev controls ──────────────────────────────────────────────────────

  /** Program the next submission for `redemptionId` to fail with the given disposition. */
  failNext(redemptionId: string, code: string, retryable: boolean, message = code): void {
    this.faults.set(redemptionId, new PayoutProviderError(code, message, retryable));
  }

  clearFault(redemptionId: string): void {
    this.faults.delete(redemptionId);
  }

  /** Make the next submission return `submitted` (in flight) instead of settling. */
  holdAsSubmitted(redemptionId: string): void {
    this.pendingIds.add(redemptionId);
  }

  /** Settle a previously-submitted payout, as the rail's own webhook/poll eventually would. */
  markPaid(redemptionId: string): void {
    const snap = this.sent.get(redemptionId);
    if (snap) this.sent.set(redemptionId, { ...snap, status: "paid" });
  }

  reset(): void {
    this.sent.clear();
    this.faults.clear();
    this.pendingIds = new Set();
  }
}
