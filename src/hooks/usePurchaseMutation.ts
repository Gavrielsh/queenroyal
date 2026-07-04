"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ApiError, confirmMockStripeDeposit, initiateStorePurchase } from "@/lib/apiClient";
import {
  getOrCreateAttemptToken,
  markAbandoned,
  markAttemptReleased,
  markAttemptStarted,
  markSettled,
} from "@/lib/purchaseIntent";
import { invalidateWalletBalances } from "@/lib/walletInvalidate";

/**
 * The purchase flow as a React Query mutation, with deterministic idempotency.
 *
 * Every attempt rides the package's RETAINED attempt token (purchaseIntent), so a user-driven
 * retry — same tab, after a reload, or from another tab — reaches the gateway with the SAME
 * `operator_transaction_id` anchor and can never double-charge or double-credit. The mutation
 * itself never auto-retries (`retry: false`): re-initiating a money call is a user decision,
 * and when they make it the token is already waiting.
 *
 * Token lifecycle mapping (the client half of the idempotency contract):
 *   - attempt starts   → `markAttemptStarted`  (peers lock Buy; token untouched)
 *   - settled          → `markSettled`         (terminal: rotate token, peers unlock)
 *   - business decline → `markAbandoned`       (terminal: rotate token, peers unlock)
 *   - retryable fault  → `markAttemptReleased` (non-terminal: peers unlock, token RETAINED)
 *
 * Settlement re-reads the ledger through the shared invalidation choke point
 * (walletInvalidate), so `wallet.invalidated { trigger: "purchase" }` is emitted exactly once
 * and every window converges on the fresh snapshot from one deduped read.
 */

/**
 * Exhaustive classification of a failed attempt. The `kind` decides the token's fate:
 * `declined` is the ONLY terminal kind (business rejection — retrying the same attempt is
 * meaningless), while `unauthorized` and `retryable` both RETAIN the token, because the
 * attempt may legitimately be retried (after login / after the fault clears) and must then
 * dedupe against anything the server already did.
 */
export type PurchaseFailure =
  | { kind: "unauthorized" }
  | { kind: "retryable"; errorCode: string | null; message: string }
  | { kind: "declined"; errorCode: string | null; message: string };

/** What a purchase attempt resolved to. Never a thrown exception — always a typed outcome. */
export type PurchaseOutcome =
  | { status: "settled"; walletSynced: boolean }
  | { status: "failed"; failure: PurchaseFailure };

export function classifyPurchaseError(error: unknown): PurchaseFailure {
  if (error instanceof ApiError) {
    if (error.status === 401) return { kind: "unauthorized" };

    const transportFault = error.status === 0 || error.status >= 500; // network/abort/5xx
    const contended = error.status === 408 || error.status === 429; // timeout / rate-limit
    const garbled = error.code === "MALFORMED_RESPONSE"; // 2xx with an unusable body
    if (transportFault || contended || garbled) {
      return { kind: "retryable", errorCode: error.code ?? null, message: error.message };
    }

    // Every remaining status is a business 4xx: the gateway understood the attempt and said
    // no (declined card, bad package, validation). Retrying the same attempt cannot succeed.
    return { kind: "declined", errorCode: error.code ?? null, message: error.message };
  }

  // A non-ApiError is a client-side fault of unknown shape — retaining the token is always
  // the safe default (the server dedupes whatever may have already happened).
  return { kind: "retryable", errorCode: null, message: "Unexpected client fault" };
}

interface PurchaseVariables {
  packageId: string;
}

interface PurchaseSettlement {
  walletSynced: boolean;
}

export interface PurchaseMutationView {
  /** Run one attempt for this package. Never throws; resolves a typed outcome. */
  purchase: (packageId: string) => Promise<PurchaseOutcome>;
  /** True from initiate through settle+re-read — the whole money window. */
  isPending: boolean;
  /** The package currently in flight, or null (drives the per-button "BUYING…" label). */
  pendingPackageId: string | null;
}

export function usePurchaseMutation(): PurchaseMutationView {
  const queryClient = useQueryClient();

  const mutation = useMutation<PurchaseSettlement, Error, PurchaseVariables>({
    mutationKey: ["purchase"],
    retry: false,
    mutationFn: async ({ packageId }) => {
      const token = getOrCreateAttemptToken(packageId);
      markAttemptStarted(packageId);
      const intent = await initiateStorePurchase(packageId, token);
      // `already_settled` (the confirm-after-settle guard fired) means the money question is
      // already answered — proceed to the same settle path; markSettled is a quiet no-op.
      await confirmMockStripeDeposit(intent);
      // Terminal success: rotate the token BEFORE the re-read — the money is settled
      // regardless of whether the balance read that follows succeeds.
      markSettled(packageId);
      const synced = await invalidateWalletBalances(queryClient, "purchase");
      return { walletSynced: synced.ok };
    },
  });

  const { mutateAsync, isPending, variables } = mutation;

  const purchase = useCallback(
    async (packageId: string): Promise<PurchaseOutcome> => {
      try {
        const settlement = await mutateAsync({ packageId });
        return { status: "settled", walletSynced: settlement.walletSynced };
      } catch (error) {
        const failure = classifyPurchaseError(error);
        if (failure.kind === "declined") {
          markAbandoned(packageId); // terminal: rotate the token, unlock peer tabs
        } else {
          markAttemptReleased(packageId); // non-terminal: unlock peer tabs, RETAIN the token
        }
        return { status: "failed", failure };
      }
    },
    [mutateAsync],
  );

  return {
    purchase,
    isPending,
    pendingPackageId: isPending ? (variables?.packageId ?? null) : null,
  };
}
