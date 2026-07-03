"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { ApiError, type WalletBalancesDto } from "@/lib/apiClient";
import { walletKeys } from "@/lib/queryKeys";
import { walletBalancesQueryFn } from "@/lib/walletQueryFn";

/**
 * THE read surface for wallet balances in Zone 3.
 *
 * Server state lives in exactly one place: the React Query cache entry under
 * `walletKeys.balances()`. Every consumer of this hook observes that single entry, so all
 * components converge on the same authoritative snapshot by construction — there is no local
 * balance state anywhere in the frontend (the old Zustand mirror is gone), and therefore no
 * second copy to race, drift, or clobber.
 *
 * The hook is a pure adapter: it maps React Query's `status`/`fetchStatus`/`dataUpdatedAt`
 * onto the UI's existing four-phase vocabulary and NEVER computes money — balances stay the
 * engine's validated decimal strings, verbatim (validation happens in the queryFn boundary,
 * M1-T3). It emits no telemetry of its own: query errors are reported once, centrally, by the
 * QueryCache.onError choke point (M1-T2).
 */

/** The UI's sync-state vocabulary (unchanged from the pre-React-Query mirror). */
export type WalletPhase =
  /** Nothing fetched yet — render placeholders, never zeros (a zero is a claim). */
  | "empty"
  /** A fetch is in flight; any displayed values may be stale. */
  | "syncing"
  /** The rendered values equal the gateway's last authoritative response. */
  | "synced"
  /** The last fetch failed — values (if any) are stale and the UI must say so. */
  | "error";

/** Outcome of a caller-initiated re-read, with just enough detail to pick honest copy. */
export type WalletRefetchResult =
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
  /** Re-read the authoritative snapshot now. Never throws; concurrent calls are deduped. */
  refetch: () => Promise<WalletRefetchResult>;
}

function toErrorParts(error: unknown): { errorStatus: number | null; errorCode: string | null } {
  if (error instanceof ApiError) {
    return { errorStatus: error.status, errorCode: error.code ?? null };
  }
  return { errorStatus: null, errorCode: null };
}

export function useWalletQuery(): WalletQueryView {
  const query = useQuery({
    queryKey: walletKeys.balances(),
    queryFn: walletBalancesQueryFn,
  });

  const { refetch: rqRefetch } = query;
  const refetch = useCallback(async (): Promise<WalletRefetchResult> => {
    const result = await rqRefetch();
    if (result.status === "success") return { ok: true };
    return { ok: false, ...toErrorParts(result.error) };
  }, [rqRefetch]);

  // Precedence mirrors the old mirror's semantics exactly: any in-flight fetch shows
  // "syncing" (even over stale data or a failed previous attempt); a genuine query error
  // shows "error" (aborts never reach error state — React Query reverts cancellations, and
  // the M1-T3 boundary classifies them ABORTED, not as transport faults); data means
  // "synced"; otherwise nothing has been fetched yet.
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
    refetch,
  };
}
