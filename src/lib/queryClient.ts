import { isServer, QueryCache, QueryClient, type QueryClientConfig } from "@tanstack/react-query";

import { ApiError } from "@/lib/apiClient";
import { logEvent } from "@/lib/telemetry";

/**
 * Money-appropriate query defaults for Zone 3. Balances must be fresh, so `staleTime` is short;
 * transient transport faults are absorbed by `retry` (React Query's default `retryDelay` is
 * exponential backoff, capped at 30s); focus/reconnect refetch keeps a returning tab honest.
 *
 * NOTE: these get re-tuned in M4 once the realtime push channel lands — when the channel is
 * healthy, `staleTime` rises (pushes keep data fresh) and focus/interval refetch stands down;
 * when degraded it reverts to exactly these values. See the blueprint's tuning matrix.
 */
export const QUERY_DEFAULTS = {
  staleTime: 5_000,
  retry: 3,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

type ClientDefaults = NonNullable<QueryClientConfig["defaultOptions"]>;

/**
 * Build a QueryClient with the Zone 3 policy and a single global telemetry choke point: every
 * query error (whichever hook triggered it) is reported once via the QueryCache. `overrides`
 * lets tests tune the policy (e.g. `retry: false`, `gcTime: 0`) without duplicating it.
 */
export function makeQueryClient(overrides?: ClientDefaults): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        const code = error instanceof ApiError ? (error.code ?? "UNKNOWN") : "UNKNOWN";
        const root = query.queryKey[0];
        const scope = typeof root === "string" ? root : "unknown";
        logEvent("wallet.query.error", { code, scope });
      },
    }),
    defaultOptions: {
      ...overrides,
      queries: {
        ...QUERY_DEFAULTS,
        ...overrides?.queries,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * SSR-safe accessor. On the server a FRESH client is returned on every call so cache can never
 * leak across requests; in the browser a single client is reused for the whole session so React
 * re-renders / Suspense never discard in-flight cache.
 */
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}
