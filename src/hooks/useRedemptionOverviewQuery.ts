"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { fetchRedemptionOverview, type RedemptionOverviewDto } from "@/lib/apiClient";
import { redemptionKeys } from "@/lib/queryKeys";
import { toErrorParts } from "@/lib/walletInvalidate";

/**
 * THE read surface for the cashier screen: KYC status (from the user row, NEVER the JWT — the
 * token is stale until the next login), history (newest first, capped at 50 server-side), and
 * the resolved policy (minimum, per-request/daily/monthly caps, remaining-today/this-month).
 *
 * This is deliberately a separate cache entry from `walletKeys.balances()` (G1): redemption
 * policy/history is not a balance, and mixing it into the wallet entry would make the "one
 * wallet cache entry" invariant unverifiable by inspection.
 */

export type RedemptionOverviewPhase = "empty" | "syncing" | "synced" | "error";

export interface RedemptionOverviewView {
  overview: RedemptionOverviewDto | null;
  phase: RedemptionOverviewPhase;
  errorStatus: number | null;
  errorCode: string | null;
  /** Re-fetch after a redemption attempt settles, so history + remaining caps catch up. */
  refetch: () => Promise<void>;
}

export function useRedemptionOverviewQuery(): RedemptionOverviewView {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: redemptionKeys.overview(),
    queryFn: ({ signal }) => fetchRedemptionOverview({ signal }),
  });

  const refetch = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: redemptionKeys.overview() });
  }, [queryClient]);

  const phase: RedemptionOverviewPhase =
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
    overview: query.data ?? null,
    phase,
    errorStatus,
    errorCode,
    refetch,
  };
}
