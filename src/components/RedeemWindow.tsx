"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";
import { ActionNotice, useActionNotice } from "@/components/feedback/ActionNotice";
import { BalanceChip } from "@/components/wallet/BalanceChip";
import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";
import { useRedemptionMutation } from "@/hooks/useRedemptionMutation";
import { useRedemptionOverviewQuery } from "@/hooks/useRedemptionOverviewQuery";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import { isMoneyString, type RedemptionStatus } from "@/lib/apiClient";
import { formatBalance } from "@/lib/format";
import { REDEMPTION_REFUSAL_COPY } from "@/lib/redemptionRefusalCopy";

/**
 * Cashier redemption window (Zone 3) — a DUMB client, same contract as StoreWindow.
 *
 * Every number a player can act on (the caps, the remaining-today/this-month figures, whether
 * they may redeem at all) comes from `GET /api/store/redemptions`, resolved server-side against
 * the player's own `residenceState` and their own non-rejected request history. This component
 * never resolves a cap itself — `POST /store/redeem` (via `useRedemptionMutation`) stays the
 * sole authority on whether an attempt succeeds; the numbers shown here are a preview, not a
 * promise.
 *
 * The redeemable figure is deliberately labeled "available to redeem", never "SC" alone — the
 * player's TOTAL SC (played + unplayed) is not this screen's business and is never fetched here.
 */

const RETRY_SAFE_COPY = "Your attempt is saved — retrying is safe and can never double-charge.";

const STATUS_LABEL: Readonly<Record<RedemptionStatus, string>> = {
  REQUESTED: "Requested",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  PROCESSING: "Processing",
  PAID: "Paid",
  REJECTED: "Rejected",
  CANCELLED_BY_PLAYER: "Cancelled",
};

const STATUS_TONE: Readonly<Record<RedemptionStatus, string>> = {
  REQUESTED: "text-pending",
  UNDER_REVIEW: "text-pending",
  APPROVED: "text-pending",
  PROCESSING: "text-pending",
  PAID: "text-success",
  REJECTED: "text-danger",
  CANCELLED_BY_PLAYER: "text-ink-faint",
};

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function RedeemWindow() {
  const { balances, phase: walletPhase, errorStatus, lastSyncedAt } = useWalletQuery();
  const { overview, phase: overviewPhase, refetch } = useRedemptionOverviewQuery();
  const { redeem, isPending, isBlocked } = useRedemptionMutation();
  const { notice, showNotice, dismissNotice } = useActionNotice();

  const [amount, setAmount] = useState("");

  const kycVerified = overview?.kycStatus === "VERIFIED";
  const policy = overview?.policy ?? null;
  const jurisdictionPermitted = policy?.jurisdictionPermitted === true;

  const amountValid = isMoneyString(amount) && amount !== "0";

  const canSubmit =
    amountValid &&
    !isBlocked &&
    overviewPhase === "synced" &&
    kycVerified &&
    jurisdictionPermitted;

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!amountValid || isBlocked) return;

      const outcome = await redeem({ amount });
      if (outcome.status === "blocked") return;

      if (outcome.status === "settled") {
        setAmount("");
        showNotice(
          outcome.walletSynced
            ? { kind: "success", message: `Redemption of ${formatBalance(outcome.result.amount)} SC submitted for review.` }
            : { kind: "error", message: "Redemption submitted, but the wallet re-read failed — balances may be stale." },
        );
        void refetch();
        return;
      }

      const { failure } = outcome;
      switch (failure.kind) {
        case "unauthorized":
          showNotice({ kind: "error", message: "Log in to redeem." });
          break;
        case "refused":
          showNotice({ kind: "error", message: REDEMPTION_REFUSAL_COPY[failure.code] });
          break;
        case "inFlight":
          showNotice({
            kind: "error",
            message: `A redemption attempt is already being processed. ${RETRY_SAFE_COPY}`,
          });
          break;
        case "unavailable":
          showNotice({
            kind: "error",
            message: `Redemption failed: could not reach the cashier. ${RETRY_SAFE_COPY}`,
          });
          break;
        case "declined":
          showNotice({ kind: "error", message: `Redemption failed: ${failure.message}` });
          break;
      }
    },
    [amount, amountValid, isBlocked, redeem, refetch, showNotice],
  );

  const history = useMemo(() => overview?.requests ?? [], [overview]);

  return (
    <div className="relative w-full max-w-md rounded-card border-2 border-sc-redeemable/35 bg-gradient-to-b from-surface-2 via-surface-1 to-surface-0 p-6 shadow-glow-sc">
      <div className="mb-6 flex flex-col items-center text-center">
        <CandyIcon name="trophy" className="mb-1 h-12 w-12 drop-shadow-[0_6px_8px_rgba(0,0,0,0.35)]" />
        <h2 className="font-display text-3xl font-semibold tracking-wide text-sc-redeemable drop-shadow-[0_3px_0_rgba(0,0,0,0.35)]">
          CASHIER
        </h2>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.3em] text-ink-faint">
          Redeem your Sweeps Coins
        </p>
      </div>

      <div className="mb-2">
        <p className="mb-1 text-center text-[10px] font-bold uppercase tracking-wider text-ink-faint">
          Available to redeem
        </p>
        <BalanceChip family="scRedeemable" value={balances?.scRedeemable ?? null} stale={walletPhase === "error"} />
      </div>
      <WalletStatusBanner phase={walletPhase} errorStatus={errorStatus} lastSyncedAt={lastSyncedAt} reconcilePhase="idle" />

      {overviewPhase === "error" && (
        <p role="alert" className="mt-4 rounded-chip border border-danger/40 bg-danger/10 px-3 py-2 text-center text-xs font-semibold text-danger">
          Could not load redemption details. Try refreshing the page.
        </p>
      )}

      {overviewPhase === "synced" && !jurisdictionPermitted && (
        <p role="alert" className="mt-4 rounded-chip border border-danger/40 bg-danger/10 px-3 py-2 text-center text-xs font-semibold text-danger">
          {REDEMPTION_REFUSAL_COPY.JURISDICTION_NOT_PERMITTED}
        </p>
      )}

      {overviewPhase === "synced" && jurisdictionPermitted && !kycVerified && (
        <p className="mt-4 rounded-chip border border-pending/40 bg-pending/10 px-3 py-2 text-center text-xs font-semibold text-pending">
          {REDEMPTION_REFUSAL_COPY.KYC_NOT_VERIFIED}{" "}
          <Link href="/kyc" className="underline underline-offset-2">
            Verify now
          </Link>
        </p>
      )}

      {overviewPhase === "synced" && jurisdictionPermitted && policy && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded-chip border border-edge bg-surface-0/60 px-3 py-2 text-[11px] text-ink-mute">
          <dt>Minimum</dt>
          <dd className="text-right tabular-nums text-ink">{formatBalance(policy.minimumAmount)} SC</dd>
          <dt>Per-request cap</dt>
          <dd className="text-right tabular-nums text-ink">{formatBalance(policy.maximumPerRequest)} SC</dd>
          <dt>Daily cap</dt>
          <dd className="text-right tabular-nums text-ink">{formatBalance(policy.dailyCap)} SC</dd>
          <dt>Remaining today</dt>
          <dd className="text-right tabular-nums text-ink">{formatBalance(policy.remainingToday)} SC</dd>
          <dt>Monthly cap</dt>
          <dd className="text-right tabular-nums text-ink">{formatBalance(policy.monthlyCap)} SC</dd>
          <dt>Remaining this month</dt>
          <dd className="text-right tabular-nums text-ink">{formatBalance(policy.remainingThisMonth)} SC</dd>
        </dl>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 space-y-3">
        <label htmlFor="redeem-amount" className="block text-[10px] font-bold uppercase tracking-wider text-ink-faint">
          Amount (SC)
        </label>
        <input
          id="redeem-amount"
          name="amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={isBlocked || !kycVerified || !jurisdictionPermitted}
          placeholder="0.00"
          className="w-full rounded-chip border-2 border-edge bg-surface-0/60 px-3 py-2 text-center font-display text-lg tabular-nums text-ink outline-none focus:border-sc-redeemable disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn-candy btn-violet w-full disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? "Submitting…" : "Redeem"}
        </button>
      </form>

      <ActionNotice notice={notice} onDismiss={dismissNotice} />

      <div className="mt-8">
        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
          Request history
        </h3>
        {history.length === 0 ? (
          <p className="text-center text-xs text-ink-faint">No redemption requests yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between rounded-chip border border-edge bg-surface-0/60 px-3 py-2 text-xs"
              >
                <div>
                  <p className="font-semibold tabular-nums text-ink">{formatBalance(entry.amount)} SC</p>
                  <p className="text-ink-faint">{formatTimestamp(entry.createdAt)}</p>
                </div>
                <span className={`font-bold uppercase tracking-wider ${STATUS_TONE[entry.status]}`}>
                  {STATUS_LABEL[entry.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
