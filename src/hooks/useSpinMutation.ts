"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, submitSpin, type SpinCurrency, type SpinResultDto } from "@/lib/apiClient";
import {
  getOrCreateSpinAttempt,
  markSpinAbandoned,
  markSpinRetained,
  markSpinSettled,
} from "@/lib/spinIntent";
import { logEvent } from "@/lib/telemetry";
import { invalidateWalletBalances } from "@/lib/walletInvalidate";

/**
 * The server-authoritative spin as a React Query mutation.
 *
 * The browser's entire role in a wager is: name a stake, name a game, carry an idempotency
 * token, and render whatever the ledger says happened. There is no local outcome, no
 * optimistic deduction, and no win math anywhere in this file — the engine draws the reels
 * from crypto/rand, evaluates its version-pinned paytable, bounds the payout, and settles the
 * debit and the credit in ONE transaction under ONE wallet lock before this hook ever sees a
 * byte.
 *
 * ── WHY THERE IS NO RECONCILER HERE (a deliberate divergence from usePurchaseMutation) ─────
 *
 * A purchase credit is webhook-driven and therefore EVENTUALLY consistent, so that flow arms
 * `armReconcile` and polls until the ledger's answer moves. A spin is not: by the time the
 * gateway returns 200, both ledger legs are committed, so the very next read is authoritative
 * and a single invalidation is complete. Arming the reconciler here would be actively wrong —
 * on a `GHOST_RECOVERED` replay the balances already reflect the round, so a
 * poll-until-changed loop would find nothing to converge on and burn its whole budget before
 * standing down as `exhausted`, showing the player a "still settling" state for a round that
 * settled minutes ago.
 *
 * ── SINGLE FLIGHT ──────────────────────────────────────────────────────────────────────────
 *
 * A ref-guard makes a double-click a no-op at the money boundary rather than relying on the
 * button's `disabled` attribute (which a fast double-click can beat between paint frames).
 * The server's player-scoped attempt anchor is still the durable authority; this is the cheap
 * local half of the same contract.
 *
 * The mutation never auto-retries (`retry: false`): re-wagering is a player decision, and when
 * they make it the retained token is already waiting.
 */

/** Exhaustive classification of a failed attempt. The `kind` decides the token's fate. */
export type SpinFailure =
  /** No valid session. Retryable after login — the token is RETAINED. */
  | { kind: "unauthorized" }
  /** The stake exceeds the balance. Nothing was written; the token rotates. */
  | { kind: "insufficientFunds"; errorCode: string | null; message: string }
  /**
   * Transport fault, 5xx, 503, timeout, throttle, or an unreadable 2xx body. The round's fate
   * is UNKNOWN — it may have committed with the response lost. Token RETAINED so the retry
   * ghost-recovers the original round instead of drawing a second one.
   */
  | { kind: "unavailable"; errorCode: string | null; message: string }
  /** 409: this exact attempt is still settling server-side. Token RETAINED. */
  | { kind: "inFlight"; errorCode: string | null; message: string }
  /** Any other business 4xx (unknown game, KYC gate, geo block, validation). Token rotates. */
  | { kind: "declined"; errorCode: string | null; message: string };

/** What a spin attempt resolved to. Never a thrown exception — always a typed outcome. */
export type SpinOutcome =
  | { status: "settled"; result: SpinResultDto; walletSynced: boolean }
  | { status: "failed"; failure: SpinFailure; walletSynced: boolean }
  /** A spin was already in flight, or the cooldown is active. This call did nothing. */
  | { status: "blocked" };

/**
 * How long the spin affordance stays locked after an `unavailable` outcome.
 *
 * A bounded cooldown, not a permanent disable: the outage is transient by definition, and a
 * UI that can never re-enable itself without a reload is a worse failure than the one it is
 * reacting to. Long enough that a wedged gateway is not hammered, short enough that recovery
 * feels immediate.
 */
export const SPIN_UNAVAILABLE_COOLDOWN_MS = 5_000;

export function classifySpinError(error: unknown): SpinFailure {
  if (error instanceof ApiError) {
    if (error.status === 401) return { kind: "unauthorized" };

    // A 2xx whose body failed the validation gate. We cannot tell what the ledger did, so it
    // is treated exactly like a transport fault: retain the token and re-read.
    if (error.code === "MALFORMED_SPIN" || error.code === "MALFORMED_RESPONSE") {
      return { kind: "unavailable", errorCode: error.code, message: error.message };
    }

    // 409: the gateway's attempt-anchor gate or the engine's idempotency barrier says this
    // key is already working. Never a fresh wager — always the same one.
    if (error.status === 409) {
      return { kind: "inFlight", errorCode: error.code ?? null, message: error.message };
    }

    if (error.status === 400 && error.code === "INSUFFICIENT_FUNDS") {
      return { kind: "insufficientFunds", errorCode: error.code, message: error.message };
    }

    const transportFault = error.status === 0 || error.status >= 500; // network/abort/5xx/503
    const contended = error.status === 408 || error.status === 429; // timeout / rate-limit
    if (transportFault || contended) {
      return { kind: "unavailable", errorCode: error.code ?? null, message: error.message };
    }

    // Every remaining status is a business 4xx: the gateway understood the wager and refused
    // it (unknown game, KYC gate, geo block, schema validation). Nothing was written.
    return { kind: "declined", errorCode: error.code ?? null, message: error.message };
  }

  // A non-ApiError is a client-side fault of unknown shape. Retaining the token is always the
  // safe default — the server dedupes whatever may already have happened.
  return { kind: "unavailable", errorCode: null, message: "Unexpected client fault" };
}

/**
 * Whether a failure leaves the ledger possibly-moved (or leaves the rendered balance suspect),
 * and therefore warrants a re-read.
 *
 *   unavailable / inFlight    → the round may have committed; we must go look.
 *   insufficientFunds         → the rejection is often caused by a STALE rendered balance;
 *                               re-reading replaces the number that misled the player.
 *   unauthorized / declined   → nothing moved, and for 401 the read would fail identically.
 */
function shouldResyncAfter(failure: SpinFailure): boolean {
  return (
    failure.kind === "unavailable" ||
    failure.kind === "inFlight" ||
    failure.kind === "insufficientFunds"
  );
}

export interface SpinVariables {
  gameId: string;
  currency: SpinCurrency;
  /** A validated decimal string. Never a number — see guardrail G2. */
  betAmount: string;
}

interface SpinSettlement {
  result: SpinResultDto;
  walletSynced: boolean;
}

export interface SpinMutationView {
  /** Run one attempt. Never throws; resolves a typed outcome. */
  spin: (variables: SpinVariables) => Promise<SpinOutcome>;
  /** True for the whole money window: request in flight through the post-settle re-read. */
  isPending: boolean;
  /** True while the post-outage lockout is active. */
  isCoolingDown: boolean;
  /** `isPending || isCoolingDown` — the single flag the spin affordance should bind to. */
  isBlocked: boolean;
}

export function useSpinMutation(): SpinMutationView {
  const queryClient = useQueryClient();
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  // Single-flight guard. A ref, not `isPending`: state updates are async and a fast double
  // click can land two calls inside one render.
  const inFlightRef = useRef(false);

  const mutation = useMutation<SpinSettlement, Error, SpinVariables>({
    mutationKey: ["spin"],
    retry: false,
    mutationFn: async ({ gameId, currency, betAmount }) => {
      // Mint-or-reuse: a retry of THIS attempt must carry the token the failed attempt used.
      const attemptToken = getOrCreateSpinAttempt(gameId);
      const result = await submitSpin({ gameId, currency, betAmount, attemptToken });
      // Terminal success: rotate the token BEFORE the re-read — the round is settled at the
      // ledger regardless of whether the balance read that follows succeeds.
      markSpinSettled(gameId);
      logEvent("spin.settled", { gameId, line: result.outcome.line, status: result.status });
      // The ONLY balance update path: mark the shared entry stale and let the one validated
      // fetch path answer. `result.postBalances` is deliberately not written anywhere (G1).
      const synced = await invalidateWalletBalances(queryClient, "spin");
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

  const spin = useCallback(
    async (variables: SpinVariables): Promise<SpinOutcome> => {
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
        const failure = classifySpinError(error);

        // Token fate — the money-critical branch. Only outcomes that provably wrote nothing
        // rotate the key; everything else retains it so a retry converges on the same round.
        if (failure.kind === "insufficientFunds" || failure.kind === "declined") {
          markSpinAbandoned(variables.gameId);
        } else {
          markSpinRetained(variables.gameId);
        }

        logEvent("spin.failed", {
          gameId: variables.gameId,
          kind: failure.kind,
          errorCode: failure.kind === "unauthorized" ? "UNAUTHORIZED" : (failure.errorCode ?? "none"),
        });

        if (failure.kind === "unavailable") {
          setCooldownUntil(Date.now() + SPIN_UNAVAILABLE_COOLDOWN_MS);
        }

        let walletSynced = false;
        if (shouldResyncAfter(failure)) {
          const synced = await invalidateWalletBalances(queryClient, "spin");
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
    spin,
    isPending,
    isCoolingDown,
    isBlocked: isPending || isCoolingDown,
  };
}
