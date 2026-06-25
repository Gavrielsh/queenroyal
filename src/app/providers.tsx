"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { type ReactNode } from "react";

import { getQueryClient } from "@/lib/queryClient";

// Devtools load as a separate, browser-only chunk and render in non-production only — they
// never enter the production First Load JS and never run during SSR.
const ReactQueryDevtools = dynamic(
  () => import("@tanstack/react-query-devtools").then((m) => m.ReactQueryDevtools),
  { ssr: false },
);

/**
 * Client boundary that supplies the single React Query cache to the whole app. Uses the
 * SSR-safe `getQueryClient()` (fresh per server render, singleton in the browser) so the cache
 * never leaks across server requests.
 */
export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  const showDevtools = process.env.NODE_ENV !== "production";

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {showDevtools ? <ReactQueryDevtools /> : null}
    </QueryClientProvider>
  );
}
