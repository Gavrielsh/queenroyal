import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { type ReactElement, type ReactNode } from "react";

import { makeQueryClient } from "@/lib/queryClient";

/** RTL result augmented with the test's QueryClient so tests can inspect or seed the cache. */
export interface RenderWithClientResult extends RenderResult {
  queryClient: QueryClient;
}

/**
 * Render `ui` wrapped in a fresh, test-tuned QueryClient: `retry: false` (a failing query fails
 * fast instead of waiting on exponential backoff) and `gcTime: 0` (cache never bleeds between
 * tests). A new client per call keeps tests isolated.
 */
export function renderWithClient(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderWithClientResult {
  const queryClient = makeQueryClient({ queries: { retry: false, gcTime: 0 } });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient };
}
