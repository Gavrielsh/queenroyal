import type { QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/apiClient";
import { walletKeys } from "@/lib/queryKeys";
import { logEvent } from "@/lib/telemetry";

/**
 * THE single invalidation choke point for the wallet cache entry.
 *
 * Every money event that can change the ledger out-of-band funnels through here — the wallet
 * hook's `invalidate()` and the purchase mutation's settle path both delegate to this
 * function — so each user action emits `wallet.invalidated { trigger }` EXACTLY once,
 * regardless of how many components observe the wallet or which flow initiated the re-sync.
 */

/** What initiated a ledger re-sync; the closed attribution vocabulary for telemetry. */
export type WalletInvalidateTrigger = "spin" | "purchase" | "recheck";

/** Outcome of a caller-initiated re-sync, with just enough detail to pick honest copy. */
export type WalletSyncOutcome =
  | { ok: true }
  | { ok: false; errorStatus: number | null; errorCode: string | null };

/** Map an unknown query error to the outcome's status/code parts (null when not an ApiError). */
export function toErrorParts(error: unknown): { errorStatus: number | null; errorCode: string | null } {
  if (error instanceof ApiError) {
    return { errorStatus: error.status, errorCode: error.code ?? null };
  }
  return { errorStatus: null, errorCode: null };
}

/**
 * Mark the shared wallet entry stale and await the resulting refetch: every active observer
 * (all windows) converges on the fresh snapshot from ONE deduped read. Never throws — the
 * settled cache state is returned as a typed outcome.
 */
export async function invalidateWalletBalances(
  queryClient: QueryClient,
  trigger: WalletInvalidateTrigger,
): Promise<WalletSyncOutcome> {
  logEvent("wallet.invalidated", { trigger });
  await queryClient.invalidateQueries({ queryKey: walletKeys.balances() });
  const state = queryClient.getQueryState(walletKeys.balances());
  if (state?.status === "success") return { ok: true };
  return { ok: false, ...toErrorParts(state?.error) };
}
