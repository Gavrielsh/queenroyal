"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ActionNotice, useActionNotice } from "@/components/feedback/ActionNotice";
import { type DisplayPackage, PackageCard } from "@/components/store/PackageCard";
import { BalanceChip } from "@/components/wallet/BalanceChip";
import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";
import { usePurchaseMutation } from "@/hooks/usePurchaseMutation";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import { onPeerActivity } from "@/lib/purchaseIntent";
import { logEvent } from "@/lib/telemetry";

/**
 * Cashier window (Zone 3) — a DUMB client by contract.
 *
 * ARCHITECTURE NOTE — why this component never touches money:
 * The catalog below is DISPLAY COPY only (preformatted strings keyed by package id). The
 * gateway's own catalog decides what each id costs and grants, and the Go ledger decides the
 * resulting balances. The purchase itself lives in usePurchaseMutation: retained attempt
 * token → PaymentIntent → confirm → settle → shared-cache invalidation. This component only
 * renders outcomes and enforces the click discipline (one purchase at a time, across tabs).
 *
 * Balance state lives ONLY in the shared query cache (`walletKeys.balances()`) observed via
 * useWalletQuery, which hydrates itself on mount — the same entry the game window renders,
 * so a settled purchase shows up in both, by construction.
 */

const PACKAGES: readonly DisplayPackage[] = [
  { id: "pkg_starter_5", name: "Starter", price: "$5", gc: "5,000 GC", sc: "+5 SC bonus" },
  { id: "pkg_value_20", name: "Value", price: "$20", gc: "20,000 GC", sc: "+20 SC bonus", highlight: true },
  { id: "pkg_pro_50", name: "Pro", price: "$50", gc: "50,000 GC", sc: "+50 SC bonus" },
];

/** The M2 idempotency guarantee, surfaced to the player on every retryable failure. */
const RETRY_SAFE_COPY = "Your attempt is saved — retrying is safe and can never double-charge.";

export function StoreWindow() {
  const { balances, phase, errorStatus, lastSyncedAt } = useWalletQuery();
  const { purchase, isPending, pendingPackageId } = usePurchaseMutation();
  const { notice, showNotice, dismissNotice } = useActionNotice();

  /** Package id a PEER TAB is actively purchasing, or null — locks Buy here too. */
  const [peerLockedBy, setPeerLockedBy] = useState<string | null>(null);
  /** Synchronous re-entry guard: two clicks in one tick both see isPending === false. */
  const attemptGate = useRef(false);

  /** Presentation-only: which package just settled (drives the check-badge pop cycle). */
  const [justSettledId, setJustSettledId] = useState<string | null>(null);
  useEffect(() => {
    if (justSettledId === null) return;
    const timer = setTimeout(() => setJustSettledId(null), 1_400);
    return () => clearTimeout(timer);
  }, [justSettledId]);

  useEffect(() => {
    return onPeerActivity((event) => {
      setPeerLockedBy((previous) => {
        if (event.state === "in_flight") return event.packageId;
        return previous === event.packageId ? null : previous;
      });
    });
  }, []);

  const handleBuy = useCallback(
    async (pkg: DisplayPackage) => {
      if (attemptGate.current || isPending) {
        logEvent("purchase.attempt.blocked", { packageId: pkg.id, reason: "in_flight" });
        return;
      }
      if (peerLockedBy !== null) {
        logEvent("purchase.attempt.blocked", { packageId: pkg.id, reason: "peer_tab" });
        return;
      }

      attemptGate.current = true;
      try {
        const outcome = await purchase(pkg.id);

        if (outcome.status === "settled") {
          setJustSettledId(pkg.id); // presentation: the card's settle-pop badge
          showNotice(
            outcome.walletSynced
              ? { kind: "success", message: `${pkg.name} pack purchased — balances updated from the ledger.` }
              : { kind: "error", message: "Purchase settled, but the wallet re-read failed — balances may be stale." },
          );
          return;
        }

        const { failure } = outcome;
        switch (failure.kind) {
          case "unauthorized":
            showNotice({ kind: "error", message: "Log in to make a purchase." });
            break;
          case "declined":
            showNotice({ kind: "error", message: `Purchase failed: ${failure.message}` });
            break;
          case "retryable":
            // The retained AttemptToken makes a retry converge on the SAME intent server-side
            // (M2) — tell the player their money is safe, in plain words.
            showNotice({
              kind: "error",
              message:
                failure.errorCode === "NETWORK_ERROR" || failure.errorCode === null
                  ? `Purchase failed: could not reach the cashier. ${RETRY_SAFE_COPY}`
                  : `Purchase failed: ${failure.message}. ${RETRY_SAFE_COPY}`,
            });
            break;
        }
      } finally {
        attemptGate.current = false;
      }
    },
    [isPending, peerLockedBy, purchase, showNotice],
  );

  const buyLocked = isPending || peerLockedBy !== null;

  return (
    <div className="relative w-full max-w-md rounded-card border border-sc-unplayed/30 bg-gradient-to-b from-surface-1 via-surface-0 to-black p-6 shadow-glow-sc">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2 className="bg-gradient-to-r from-sc-unplayed via-teal-200 to-sc-unplayed bg-clip-text text-2xl font-black tracking-widest text-transparent">
          COIN&nbsp;STORE
        </h2>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-ink-faint">Gold Coin packages · SC on the house</p>
      </div>

      {/* Live balances — verbatim ledger strings via the shared chip (skeletons while loading). */}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <BalanceChip family="gc" value={balances?.gc ?? null} stale={phase === "error"} />
        <BalanceChip family="scUnplayed" value={balances?.scUnplayed ?? null} stale={phase === "error"} />
      </div>
      <WalletStatusBanner phase={phase} errorStatus={errorStatus} lastSyncedAt={lastSyncedAt} />

      {/* Packages — merchandising cards; lifecycle driven by the mutation's state. */}
      <ul className="space-y-3">
        {PACKAGES.map((pkg) => (
          <PackageCard
            key={pkg.id}
            pkg={pkg}
            buying={pendingPackageId === pkg.id}
            disabled={buyLocked}
            justSettled={justSettledId === pkg.id}
            onBuy={() => void handleBuy(pkg)}
          />
        ))}
      </ul>

      {peerLockedBy !== null ? (
        <p className="mt-4 flex items-center justify-center gap-2 rounded-chip border border-pending/40 bg-pending/10 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-pending">
          <span aria-hidden="true">⛓</span>
          <span>purchase in progress in another tab</span>
        </p>
      ) : (
        <p className="mt-4 text-center text-[9px] uppercase tracking-wider text-ink-faint">
          Mock checkout — payments settle server-side via the gateway
        </p>
      )}

      <ActionNotice notice={notice} onDismiss={dismissNotice} />
    </div>
  );
}
