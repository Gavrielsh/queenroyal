"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, submitRedemption, type RedemptionAcceptedDto } from "@/lib/apiClient";
import {
  getOrCreateRedemptionAttempt,
  markRedemptionAbandoned,
  markRedemptionRetained,
  markRedemptionSettled,
} from "@/lib/redemptionIntent";
import { isRedemptionRefusalCode, type RedemptionRefusalCode } from "@/lib/redemptionRefusalCopy";
import { logEvent } from "@/lib/telemetry";
import { invalidateWalletBalances } from "@/lib/walletInvalidate";

/**
 * The server-authoritative redemption as a React Query mutation — modeled directly on
 * `useSpinMutation`, not `usePurchaseMutation`.
 *
 * ── WHY THIS FOLLOWS SPIN'S SHAPE, NOT PURCHASE'S ───────────────────────────────────────────
 *
 * A purchase credit is webhook-driven and eventually consistent, so that flow arms a
 * reconciler and polls. A redemption's SC debit is not: `redemption.service.ts` commits it
 * synchronously at the engine, in this same request — the payout that follows lives on a
 * separate `RedemptionRequest` lifecycle (REQUESTED → ... → PAID) that this hook does not
 * chase. By the time the gateway answers 200/202, the debit is already final, so a single
 * wallet invalidation is complete — exactly like a spin.
 *
 * ── WHY REFUSALS DON'T TOUCH THE WALLET ──────────────────────────────────────────────────────
 *
 * `evaluateRedemption()` runs entirely BEFORE the engine call. Every one of the 8
 * `RedemptionRefusal` codes (and every other business 4xx) means nothing was ever sent to the
 * ledger, so there is nothing to resync — only `unavailable`/`inFlight` leave the debit's fate
 * unknown and warrant a re-read (G4: never guess, go look).
 */

/** Exhaustive classification of a failed attempt. The `kind` decides the token's fate. */
export type RedemptionFailure =
  /** No valid session. Retryable after login — the token is RETAINED. */
  | { kind: "unauthorized" }
  /** One of the 8 `RedemptionRefusal` codes. Nothing was written; the token rotates. */
  | { kind: "refused"; code: RedemptionRefusalCode; message: string }
  /**
   * Transport fault, 5xx, 503, timeout, throttle, or an unreadable 2xx body. The debit's fate
   * is UNKNOWN — it may have committed with the response lost. Token RETAINED so the retry
   * ghost-recovers the original attempt instead of debiting a second time.
   */
  | { kind: "unavailable"; errorCode: string | null; message: string }
  /** 409: this exact attempt token is already settling/settled/exhausted server-side. Token RETAINED. */
  | { kind: "inFlight"; errorCode: string | null; message: string }
  /** Any other business 4xx (unknown player, schema validation). Token rotates. */
  | { kind: "declined"; errorCode: string | null; message: string };

/** What a redemption attempt resolved to. Never a thrown exception — always a typed outcome. */
export type RedemptionOutcome =
  | { status: "settled"; result: RedemptionAcceptedDto; walletSynced: boolean }
  | { status: "failed"; failure: RedemptionFailure; walletSynced: boolean }
  /** A redemption was already in flight, or the cooldown is active. This call did nothing. */
  | { status: "blocked" };

/** How long the redeem affordance stays locked after an `unavailable` outcome. */
export const REDEMPTION_UNAVAILABLE_COOLDOWN_MS = 5_000;

export function classifyRedemptionError(error: unknown): RedemptionFailure {
  if (error instanceof ApiError) {
    if (error.status === 401) return { kind: "unauthorized" };

    const refusalCode = error.code ?? null;
    if (isRedemptionRefusalCode(refusalCode)) {
      return { kind: "refused", code: refusalCode, message: error.message };
    }

    // A 2xx whose body failed the validation gate. We cannot tell what the ledger did, so it
    // is treated exactly like a transport fault: retain the token and re-read.
    if (error.code === "MALFORMED_RESPONSE" || error.code === "MALFORMED_REDEMPTION_OVERVIEW") {
      return { kind: "unavailable", errorCode: error.code, message: error.message };
    }

    // 409: ATTEMPT_OWNERSHIP / ATTEMPT_SETTLED / ATTEMPT_EXHAUSTED — the gateway's attempt
    // anchor says this key is already working. Never a fresh redemption — always the same one.
    if (error.status === 409) {
      return { kind: "inFlight", errorCode: error.code ?? null, message: error.message };
    }

    const transportFault = error.status === 0 || error.status >= 500; // network/abort/5xx/503
    const contended = error.status === 408 || error.status === 429; // timeout / rate-limit
    if (transportFault || contended) {
      return { kind: "unavailable", errorCode: error.code ?? null, message: error.message };
    }

    // Every remaining status is a business 4xx the policy gate already named above, or a plain
    // validation/not-found fault (PLAYER_NOT_FOUND, VALIDATION_ERROR). Nothing was written.
    return { kind: "declined", errorCode: error.code ?? null, message: error.message };
  }

  // A non-ApiError is a client-side fault of unknown shape. Retaining the token is always the
  // safe default — the server dedupes whatever may already have happened.
  return { kind: "unavailable", errorCode: null, message: "Unexpected client fault" };
}

/**
 * Whether a failure leaves the ledger possibly-moved and therefore warrants a wallet re-read.
 * Only `unavailable`/`inFlight` qualify: every other kind is answered entirely by the policy
 * gate before the engine is ever called, so nothing could have moved.
 */
function shouldResyncAfter(failure: RedemptionFailure): boolean {
  return failure.kind === "unavailable" || failure.kind === "inFlight";
}

export interface RedemptionVariables {
  /** A validated decimal string. Never a number — see guardrail G2. */
  amount: string;
}

interface RedemptionSettlement {
  result: RedemptionAcceptedDto;
  walletSynced: boolean;
}

export interface RedemptionMutationView {
  /** Run one attempt. Never throws; resolves a typed outcome. */
  redeem: (variables: RedemptionVariables) => Promise<RedemptionOutcome>;
  /** True for the whole money window: request in flight through the post-settle re-read. */
  isPending: boolean;
  /** True while the post-outage lockout is active. */
  isCoolingDown: boolean;
  /** `isPending || isCoolingDown` — the single flag the redeem affordance should bind to. */
  isBlocked: boolean;
}

export function useRedemptionMutation(): RedemptionMutationView {
  const queryClient = useQueryClient();
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  // Single-flight guard. A ref, not `isPending`: state updates are async and a fast double
  // click can land two calls inside one render.
  const inFlightRef = useRef(false);

  const mutation = useMutation<RedemptionSettlement, Error, RedemptionVariables>({
    mutationKey: ["redemption"],
    retry: false,
    mutationFn: async ({ amount }) => {
      // Mint-or-reuse: a retry of THIS attempt must carry the token the failed attempt used.
      const attemptToken = getOrCreateRedemptionAttempt();
      const result = await submitRedemption({ amount, attemptToken });
      // Terminal success: rotate the token BEFORE the re-read — the debit is settled at the
      // ledger regardless of whether the balance read that follows succeeds.
      markRedemptionSettled();
      logEvent("redemption.settled", { redemptionId: result.redemptionId });
      // The ONLY balance update path: mark the shared entry stale and let the one validated
      // fetch path answer.
      const synced = await invalidateWalletBalances(queryClient, "redemption");
      return { result, walletSynced: synced.ok };
    },
  });

  const { mutateAsync, isPending } = mutation;

  // Release the cooldown when it expires. Re-armed on each new cooldown; cleared on unmount so
  // a pending timer can never fire into an unmounted tree.
  useEffect(() => {
    if (cooldownUntil === null) return undefined;
    const remaining = cooldownUntil - Date.now();
    if (remaining <= 0) {
      setCooldownUntil(null);
      return undefined;
    }
    const timer = setTimeout(() => setCooldownUntil(null), remaining);
    return () => clearTimeout(timer);
  }, [cooldownUntil]);

  const isCoolingDown = cooldownUntil !== null;

  const redeem = useCallback(
    async (variables: RedemptionVariables): Promise<RedemptionOutcome> => {
      if (inFlightRef.current || cooldownUntil !== null) return { status: "blocked" };
      inFlightRef.current = true;

      try {
        const settlement = await mutateAsync(variables);
        return {
          status: "settled",
          result: settlement.result,
          walletSynced: settlement.walletSynced,
        };
      } catch (error) {
        const failure = classifyRedemptionError(error);

        // Token fate — the money-critical branch. Only outcomes that provably wrote nothing
        // rotate the key; everything else retains it so a retry converges on the same attempt.
        if (failure.kind === "refused" || failure.kind === "declined") {
          markRedemptionAbandoned();
        } else {
          markRedemptionRetained();
        }

        logEvent("redemption.failed", {
          kind: failure.kind,
          errorCode:
            failure.kind === "unauthorized"
              ? "UNAUTHORIZED"
              : failure.kind === "refused"
                ? failure.code
                : (failure.errorCode ?? "none"),
        });

        if (failure.kind === "unavailable") {
          setCooldownUntil(Date.now() + REDEMPTION_UNAVAILABLE_COOLDOWN_MS);
        }

        let walletSynced = false;
        if (shouldResyncAfter(failure)) {
          const synced = await invalidateWalletBalances(queryClient, "redemption");
          walletSynced = synced.ok;
        }
        return { status: "failed", failure, walletSynced };
      } finally {
        inFlightRef.current = false;
      }
    },
    [mutateAsync, queryClient, cooldownUntil],
  );

  return {
    redeem,
    isPending,
    isCoolingDown,
    isBlocked: isPending || isCoolingDown,
  };
}
