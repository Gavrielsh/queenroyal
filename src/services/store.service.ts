import { randomUUID } from "node:crypto";

import { getPackage } from "@/config/store-packages";
import { mockStripeCharge } from "@/lib/mock-stripe";
import { trueEngine } from "@/lib/true-engine";
import type { AuthClaims } from "@/lib/jwt";
import type { PurchaseInput } from "@/schemas/store.schema";
import type { EngineTxResult, TrueEngineErrorBody } from "@/types/true-engine";

export interface PurchaseSuccess {
  paymentIntentId: string;
  transactionId: string;
  package: {
    id: string;
    label: string;
    gc: number;
    sc: number;
    priceUsdCents: number;
  };
  engine: EngineTxResult;
}

export type PurchaseOutcome =
  | { ok: true; data: PurchaseSuccess }
  | { ok: false; status: number; error: TrueEngineErrorBody };

/**
 * Cashier flow: validate package → MOCK fiat charge → instruct the True Engine to
 * credit the exact integer coin amounts. No balances are ever written locally.
 */
export async function purchasePackage(
  user: AuthClaims,
  input: PurchaseInput,
): Promise<PurchaseOutcome> {
  const pkg = getPackage(input.packageId);
  if (!pkg) {
    return {
      ok: false,
      status: 404,
      error: { code: "UNKNOWN_PACKAGE", message: `No store package with id '${input.packageId}'` },
    };
  }

  // 1) MOCK the PSP charge for the exact integer cent price.
  const charge = await mockStripeCharge({
    amountCents: pkg.priceUsdCents,
    token: input.paymentToken,
    userId: user.sub,
  });
  if (!charge.ok) {
    return {
      ok: false,
      status: 402,
      error: { code: "PAYMENT_DECLINED", message: "Payment was declined", details: charge.declineReason },
    };
  }

  // 2) Instruct the ledger to credit coins. Integers only; idempotent via transaction_id.
  const transactionId = randomUUID();
  const result = await trueEngine().sendDeposit({
    transaction_id: transactionId,
    user_id: user.sub,
    gc: pkg.gc,
    sc: pkg.sc,
    usd_cents: pkg.priceUsdCents,
    package_id: pkg.id,
    payment_ref: charge.paymentIntentId,
  });

  if (!result.ok) {
    // Money was captured by the PSP but the ledger credit failed. Surface clearly with
    // the payment + transaction refs so reconciliation / auto-refund can act. The
    // transaction_id makes a retry safe (idempotent) without double-crediting.
    return {
      ok: false,
      status: result.status === 0 ? 502 : result.status,
      error: {
        code: result.error.code,
        message: `Payment captured (${charge.paymentIntentId}) but ledger credit failed: ${result.error.message}`,
        details: {
          paymentRef: charge.paymentIntentId,
          transactionId,
          engine: result.error.details,
        },
      },
    };
  }

  return {
    ok: true,
    data: {
      paymentIntentId: charge.paymentIntentId,
      transactionId,
      package: {
        id: pkg.id,
        label: pkg.label,
        gc: pkg.gc,
        sc: pkg.sc,
        priceUsdCents: pkg.priceUsdCents,
      },
      engine: result.data,
    },
  };
}
