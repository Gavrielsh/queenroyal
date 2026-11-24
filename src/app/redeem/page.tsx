"use client";

import { AuthGate } from "@/components/auth/AuthGate";
import { RedeemWindow } from "@/components/RedeemWindow";

/**
 * Cashier page. AuthGate holds the window back until a gateway session exists, so its mount-time
 * `GET /api/store/redemptions` read is always authenticated — same contract as /casino.
 */
export default function RedeemPage() {
  return (
    <AuthGate>
      <main className="mx-auto flex w-full max-w-6xl justify-center px-4 py-10 sm:py-14">
        <RedeemWindow />
      </main>
    </AuthGate>
  );
}
