import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "QueenRoyal",
  description: "Social Sweepstakes Casino — player web UI.",
};

/**
 * Root layout for the Zone 3 web UI. Next.js is now UI-ONLY: it owns NO backend API routes
 * (`src/app/api` was removed in Phase 6). The browser talks to the standalone Fastify financial
 * gateway (Zone 2) for auth, the cashier, and all other backend calls.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          React Query cache provider. Mounted here in the root layout — ABOVE the page-level
          DevAutoLogin auth gate — so the gate and every query it gates share one client.
        */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
