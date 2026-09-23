"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { claimDailyBonus, fetchDailyBonusStatus, WheelClaimError } from "@/lib/meta/dailyBonusClient";
import type { DailyBonusClaim, DailyBonusStatus } from "@/lib/meta/types";
import { metaKeys } from "@/lib/queryKeys";
import { invalidateWalletBalances } from "@/lib/walletInvalidate";

/**
 * The live Daily Wheel: its status (slices, odds, streak, availability) and the claim.
 *
 * The attempt key follows the spin/purchase rule: it is minted per attempt and RETAINED when
 * the outcome is unknown (timeout, 5xx, in-flight), so a retry replays the original grant
 * instead of being refused; it rotates only after a terminal answer. After a grant the wallet
 * is re-read from the ledger through the shared choke point — the wheel never writes a balance.
 */
export function useDailyWheel(enabled: boolean): {
  status: DailyBonusStatus | undefined;
  isError: boolean;
  claim: () => Promise<DailyBonusClaim>;
} {
  const queryClient = useQueryClient();
  const attemptKey = useRef<string | null>(null);

  const query = useQuery({
    queryKey: metaKeys.dailyBonus(),
    queryFn: ({ signal }) => fetchDailyBonusStatus({ signal }),
    enabled,
    staleTime: 30_000,
  });

  const claim = useCallback(async (): Promise<DailyBonusClaim> => {
    attemptKey.current ??= crypto.randomUUID();
    try {
      const result = await claimDailyBonus(attemptKey.current);
      attemptKey.current = null;
      // Fire-and-forget re-reads: the wheel's own animation does not wait on them.
      void invalidateWalletBalances(queryClient, "bonus");
      void queryClient.invalidateQueries({ queryKey: metaKeys.dailyBonus() });
      return result;
    } catch (err) {
      if (!(err instanceof WheelClaimError) || !err.ambiguous) attemptKey.current = null;
      void queryClient.invalidateQueries({ queryKey: metaKeys.dailyBonus() });
      throw err;
    }
  }, [queryClient]);

  return { status: query.data, isError: query.isError, claim };
}
