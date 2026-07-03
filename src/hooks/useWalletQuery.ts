"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ApiError, type WalletBalancesDto } from "@/lib/apiClient";
import { walletKeys } from "@/lib/queryKeys";
import { logEvent } from "@/lib/telemetry";
import { walletBalancesQueryFn } from "@/lib/walletQueryFn";

/**
 * THE read surface for wallet balances in Zone 3.
 *
 * Server state lives in exactly one place: the React Query cache entry under
 * `walletKeys.balances()`. Every consumer of this hook observes that single entry, so all
 * components converge on the same authoritative snapshot by construction — there is no local
 * balance state anywhere in the frontend, and therefore no second copy to race, drift, or
 * clobber.
 *
 * The hook is a pure adapter: it maps React Query's `status`/`fetchStatus`/`dataUpdatedAt`
 * onto the UI's four-phase vocabulary and NEVER computes money — balances stay the engine's
 * validated decimal strings, verbatim (validated at the queryFn boundary:
 * walletQueryFn → parseWalletEnvelope). Read/error telemetry stays central (the
 * QueryCache.onError choke point in queryClient); the only event the hook emits is
 * `wallet.invalidated { trigger }` — exactly once per user-initiated re-sync, from
 * `invalidate()`.
 */

/** The UI's sync-state vocabulary. */
export type WalletPhase =
  /** Nothing fetched yet — render placeholders, never zeros (a zero is a claim). */
  | "empty"
  /** A fetch is in flight; any displayed values may be stale. */
  | "syncing"
  /** The rendered values equal the gateway's last authoritative response. */
  | "synced"
  /** The last fetch failed — values (if any) are stale and the UI must say so. */
  | "error";

/**
 * What initiated a ledger re-sync. Every money event that can change the wallet out-of-band
 * must invalidate through this typed vocabulary so telemetry can attribute each re-sync.
 */
export type WalletInvalidateTrigger = "spin" | "purchase";

/** Outcome of a caller-initiated re-sync, with just enough detail to pick honest copy. */
export type WalletSyncOutcome =
  | { ok: true }
  | { ok: false; errorStatus: number | null; errorCode: string | null };

export interface WalletQueryView {
  /** Validated, verbatim engine strings — or null before the first successful read. */
  balances: WalletBalancesDto | null;
  phase: WalletPhase;
  /** HTTP status of the current query error (e.g. 401 → "log in" copy), else null. */
  errorStatus: number | null;
  /** Machine-readable gateway code of the current query error, else null. */
  errorCode: string | null;
  /** Epoch ms of the last authoritative snapshot, or null if none yet (drives staleness UI). */
  lastSyncedAt: number | null;
  /**
   * Signal that a money event has (or may have) changed the ledger: marks the shared cache
   * entry stale via `queryClient.invalidateQueries` and awaits the resulting refetch — every
   * active observer (all windows) converges on the fresh snapshot from ONE deduped read.
   * Emits `wallet.invalidated { trigger }` exactly once per call. Never throws.
   */
  invalidate: (trigger: WalletInvalidateTrigger) => Promise<WalletSyncOutcome>;
}

function toErrorParts(error: unknown): { errorStatus: number | null; errorCode: string | null } {
  if (error instanceof ApiError) {
    return { errorStatus: error.status, errorCode: error.code ?? null };
  }
  return { errorStatus: null, errorCode: null };
}

export function useWalletQuery(): WalletQueryView {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: walletKeys.balances(),
    queryFn: walletBalancesQueryFn,
  });

  const invalidate = useCallback(
    async (trigger: WalletInvalidateTrigger): Promise<WalletSyncOutcome> => {
      // Emitted here — the single choke point — so each user action logs exactly one
      // invalidation regardless of how many components observe the wallet.
      logEvent("wallet.invalidated", { trigger });
      await queryClient.invalidateQueries({ queryKey: walletKeys.balances() });
      // invalidateQueries resolves once the refetch settles; the cache state is the outcome.
      const state = queryClient.getQueryState(walletKeys.balances());
      if (state?.status === "success") return { ok: true };
      return { ok: false, ...toErrorParts(state?.error) };
    },
    [queryClient],
  );

  // Phase precedence: any in-flight fetch shows "syncing" (even over stale data or a failed
  // previous attempt); a genuine query error shows "error" (aborts never reach error state —
  // React Query reverts cancellations, and the transport boundary classifies them ABORTED,
  // not as transport faults); data means "synced"; otherwise nothing has been fetched yet.
  const phase: WalletPhase =
    query.fetchStatus === "fetching"
      ? "syncing"
      : query.status === "error"
        ? "error"
        : query.data !== undefined
          ? "synced"
          : "empty";

  const { errorStatus, errorCode } =
    query.status === "error" ? toErrorParts(query.error) : { errorStatus: null, errorCode: null };

  return {
    balances: query.data ?? null,
    phase,
    errorStatus,
    errorCode,
    lastSyncedAt: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null,
    invalidate,
  };
}
