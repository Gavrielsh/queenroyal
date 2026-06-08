import { randomUUID } from "node:crypto";

import { getPackage } from "@/config/store-packages";
import { assertKycAllows, KycGateError } from "@/lib/kyc-policy";
import { wholeCoinsToMoneyString } from "@/lib/money";
import type { AuthClaims } from "@/lib/jwt";
import type { PurchaseInput } from "@/schemas/store.schema";
import { type DepositInstruction, settleDepositIntent } from "@/services/deposit.service";
import { beginEngineRequest, completeEngineRequest } from "@/services/engine-journal.service";
import { ProvisioningError, resolveTransactingPlayer } from "@/services/player-provisioning.service";
import type { EngineTxResult, PurchasePayload, TrueEngineErrorBody } from "@/types/true-engine";

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
 * Cashier flow with a PRE-CHARGE OUTBOX (zero financial loss):
 *   validate package → KYC gate → journal a PENDING DEPOSIT intent (with the full,
 *   replayable charge+credit instruction) → settle (capture + ledger credit).
 *
 * Because the intent is durably journaled BEFORE the PSP is charged, a crash at any
 * point — including immediately after capture — leaves a record the reconciler settles
 * idempotently (re-capture is a no-op; the ledger credit de-duplicates). No captured
 * funds can ever be orphaned.
 *
 * The stable anchor is a per-attempt id (the client idempotency key when supplied, else a
 * generated UUID). The PSP charge keys on it (charge-once) and the ledger credit's
 * `operator_transaction_id` is `deposit:<attemptId>`.
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

  // Identity bridge + current KYC status (single DB read; lazy provisioning).
  let player;
  try {
    player = await resolveTransactingPlayer(user.sub);
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

  // Server-side KYC gate (real-money entry point) — never trust the JWT claim.
  try {
    assertKycAllows(player.kycStatus, "PURCHASE");
  } catch (err) {
    if (err instanceof KycGateError) {
      return { ok: false, status: 403, error: { code: err.code, message: err.message } };
    }
    throw err;
  }

  const playerId = player.trueEnginePlayerId;
  const attemptId = input.idempotencyKey ?? randomUUID();
  const operatorTransactionId = `deposit:${attemptId}`;

  const scPromo = pkg.sc > 0 ? wholeCoinsToMoneyString(pkg.sc) : undefined;
  const purchase: PurchasePayload = {
    operator_transaction_id: operatorTransactionId,
    player_id: playerId,
    gc_amount: wholeCoinsToMoneyString(pkg.gc),
    ...(scPromo ? { sc_promo_amount: scPromo } : {}),
    metadata: { package_id: pkg.id, usd_cents: pkg.priceUsdCents, purchase_attempt: attemptId },
  };
  const instruction: DepositInstruction = {
    charge: { amountCents: pkg.priceUsdCents, token: input.paymentToken, userId: user.sub, idempotencyKey: attemptId },
    purchase,
  };

  // ── PRE-CHARGE OUTBOX: durably record the intent BEFORE touching the PSP. ──
  await beginEngineRequest({
    operatorTransactionId,
    type: "DEPOSIT",
    playerId,
    providerRef: attemptId,
    requestPayload: instruction,
  });

  // Settle: capture (idempotent) + ledger credit (idempotent).
  const settlement = await settleDepositIntent(instruction);
  if (settlement.kind === "declined") {
    await completeEngineRequest(operatorTransactionId, "FAILED", {
      retryable: false,
      lastError: `PAYMENT_DECLINED: ${settlement.reason ?? "card_declined"}`,
    });
    return {
      ok: false,
      status: 402,
      error: { code: "PAYMENT_DECLINED", message: "Payment was declined", details: settlement.reason },
    };
  }

  const result = settlement.engine;
  if (!result.ok) {
    await completeEngineRequest(operatorTransactionId, "FAILED", {
      retryable: result.retryable,
      lastError: `${result.error.code}: ${result.error.message}`,
    });
    // Money captured but the ledger credit failed. The intent is journaled; the
    // reconciler re-drives it to completion idempotently (no re-charge, no double credit).
    return {
      ok: false,
      status: result.status === 0 ? 502 : result.status,
      error: {
        code: result.error.code,
        message: `Payment captured (${settlement.paymentIntentId}) but ledger credit failed: ${result.error.message}`,
        details: {
          paymentRef: settlement.paymentIntentId,
          operatorTransactionId,
          retryable: result.retryable,
          engine: result.error,
        },
      },
    };
  }
  await completeEngineRequest(operatorTransactionId, "SUCCEEDED", {
    ledgerTransactionId: result.data.ledger_transaction_id,
  });

  return {
    ok: true,
    data: {
      paymentIntentId: settlement.paymentIntentId,
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
