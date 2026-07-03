import type { QueryFunctionContext } from "@tanstack/react-query";

import { fetchWalletBalances, type WalletBalancesDto } from "@/lib/apiClient";
import type { walletKeys } from "@/lib/queryKeys";

type WalletBalancesKey = ReturnType<(typeof walletKeys)["balances"]>;

/**
 * The React Query queryFn for the wallet balances query (`walletKeys.balances()`).
 *
 * Threads React Query's own AbortSignal into the gateway fetch, so a superseded refetch or an
 * unmounting consumer CANCELS the in-flight HTTP request instead of racing it — the
 * race-mitigation contract. Validation lives in `fetchWalletBalances`/`parseWalletEnvelope`:
 * a malformed payload throws (→ query error), so no unvalidated value can enter the cache
 * through this path.
 *
 * Declared over `Pick<…, "signal">` — exactly what it consumes — which keeps it assignable
 * wherever React Query expects a queryFn while staying directly unit-testable without
 * constructing a full QueryFunctionContext.
 */
export function walletBalancesQueryFn(
  context: Pick<QueryFunctionContext<WalletBalancesKey>, "signal">,
): Promise<WalletBalancesDto> {
  return fetchWalletBalances({ signal: context.signal });
}
