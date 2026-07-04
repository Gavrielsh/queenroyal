import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";
import { Providers } from "./providers";

/**
 * Brand face — self-hosted at build time by next/font (zero runtime CDN requests),
 * `display: swap` so text never blocks on the font, exposed as --font-manrope which the
 * design tokens fold into --font-sans (globals.css).
 */
const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
});

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
    <html lang="en" className={manrope.variable}>
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
