import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import type { ReactNode } from "react";

import { Footer } from "@/components/shell/Footer";
import { NavBar } from "@/components/shell/NavBar";

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
  title: "QueenRoyal — Social Sweepstakes Casino",
  description:
    "Play-for-fun social casino with sweepstakes prizes. 18+. No purchase necessary. Void where prohibited.",
};

/**
 * Root layout for the Zone 3 web UI. Next.js is now UI-ONLY: it owns NO backend API routes
 * (`src/app/api` was removed in Phase 6). The browser talks to the standalone Fastify financial
 * gateway (Zone 2) for auth, the cashier, and all other backend calls.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body className="flex min-h-screen flex-col bg-surface-0 text-ink antialiased">
        {/*
          React Query cache provider. Mounted here in the root layout — ABOVE the page-level
          DevAutoLogin auth gate — so the gate and every query it gates share one client. The
          shell (NavBar/Footer) sits inside it too: the NavBar's wallet slot consumes the same
          cache once M3-T4 wires it.
        */}
        <Providers>
          <NavBar />
          <div className="flex-1">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
