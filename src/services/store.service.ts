import { getPackage } from "@/config/store-packages";
import { wholeCoinsToMoneyString } from "@/lib/money";
import { mockStripeCharge } from "@/lib/mock-stripe";
import { trueEngine } from "@/lib/true-engine";
import type { AuthClaims } from "@/lib/jwt";
import type { PurchaseInput } from "@/schemas/store.schema";
import { beginEngineRequest, completeEngineRequest } from "@/services/engine-journal.service";
import { ProvisioningError, resolveTrueEnginePlayerId } from "@/services/player-provisioning.service";
import type { EngineTxResult, TrueEngineErrorBody } from "@/types/true-engine";

export interface PurchaseSuccess {
  paymentIntentId: string;
  operatorTransactionId: string;
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
 * Cashier flow: validate package → MOCK fiat charge → instruct the True Engine to issue
 * the exact decimal coin amounts. No balances are ever written locally.
 *
 * Idempotency: the ledger credit's `operator_transaction_id` is derived from the PSP
 * `payment_ref` (`deposit:<ref>`), so a retry de-duplicates at the ledger. The intent
 * is journaled before the engine call so a crash after capture is recoverable.
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

  // Identity bridge — resolve (and lazily provision) the engine player_id.
  let playerId: string;
  try {
    playerId = await resolveTrueEnginePlayerId(user.sub);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned in the ledger", details: err.message },
      };
    }
    throw err;
  }

  // 1) MOCK the PSP charge for the exact integer cent price (integer cents is correct
  //    at the PSP boundary only). Charge-once on retry via the client idempotency key.
  const charge = await mockStripeCharge({
    amountCents: pkg.priceUsdCents,
    token: input.paymentToken,
    userId: user.sub,
    idempotencyKey: input.idempotencyKey,
  });
  if (!charge.ok) {
    return {
      ok: false,
      status: 402,
      error: { code: "PAYMENT_DECLINED", message: "Payment was declined", details: charge.declineReason },
    };
  }

  // 2) Instruct the ledger to issue coins. Decimal strings only; deterministic key.
  const operatorTransactionId = `deposit:${charge.paymentIntentId}`;
  await beginEngineRequest({
    operatorTransactionId,
    type: "DEPOSIT",
    playerId,
    providerRef: charge.paymentIntentId,
  });

  const scPromo = pkg.sc > 0 ? wholeCoinsToMoneyString(pkg.sc) : undefined;
  const result = await trueEngine().sendPurchase({
    operator_transaction_id: operatorTransactionId,
    player_id: playerId,
    gc_amount: wholeCoinsToMoneyString(pkg.gc),
    ...(scPromo ? { sc_promo_amount: scPromo } : {}),
    metadata: { payment_ref: charge.paymentIntentId, package_id: pkg.id, usd_cents: pkg.priceUsdCents },
  });

  if (!result.ok) {
    await completeEngineRequest(operatorTransactionId, "FAILED");
    // Money captured by the PSP but the ledger credit failed. Surface clearly with the
    // refs so reconciliation / auto-refund can act. The deterministic key makes a retry
    // safe (idempotent) without double-crediting.
    return {
      ok: false,
      status: result.status === 0 ? 502 : result.status,
      error: {
        code: result.error.code,
        message: `Payment captured (${charge.paymentIntentId}) but ledger credit failed: ${result.error.message}`,
        details: {
          paymentRef: charge.paymentIntentId,
          operatorTransactionId,
          retryable: result.retryable,
          engine: result.error,
        },
      },
    };
  }
  await completeEngineRequest(operatorTransactionId, "SUCCEEDED", result.data.ledger_transaction_id);

  return {
    ok: true,
    data: {
      paymentIntentId: charge.paymentIntentId,
      operatorTransactionId,
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
