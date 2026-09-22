"use client";

import { CandyIcon } from "@/components/art/CandyIcon";

/**
 * Store package card — pure merchandising over DISPLAY COPY.
 *
 * Every string on this card (price, coin amounts, bonus line) is preformatted display copy
 * keyed by the gateway catalog id; the card computes nothing (no price math, no client-side
 * money). The purchase lifecycle it renders — idle → buying (in-button spinner) → settled
 * (check-badge pop) — is driven exclusively by state the caller derives from
 * usePurchaseMutation; the card owns zero flow logic.
 */
export interface DisplayPackage {
  /** Must match a gateway catalog id (apps/financial-gateway/src/config/store-packages.ts). */
  id: string;
  name: string;
  /** Preformatted display strings — never computed or parsed in the browser. */
  price: string;
  gc: string;
  sc: string;
  highlight?: boolean;
}

export interface PackageCardProps {
  pkg: DisplayPackage;
  /** This package's purchase is on the wire (pendingPackageId === pkg.id). */
  buying: boolean;
  /** ANY purchase is in flight (here or in a peer tab) — one purchase at a time. */
  disabled: boolean;
  /** Transient settle confirmation (the caller clears it after the pop cycle). */
  justSettled: boolean;
  onBuy: () => void;
}

export function PackageCard({ pkg, buying, disabled, justSettled, onBuy }: PackageCardProps) {
  return (
    <li
      className={`group relative overflow-hidden rounded-card border-2 p-4 transition duration-300 ${
        pkg.highlight
          ? "border-gc/60 bg-gradient-to-br from-surface-3 via-surface-2 to-surface-1 shadow-glow-gc"
          : "border-edge bg-surface-2/70"
      } ${disabled ? "" : "hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-lift"}`}
    >
      {pkg.highlight && (
        <span
          aria-hidden="true"
          className="absolute -right-9 top-4 rotate-45 bg-gradient-to-r from-candy to-[#ff7ab8] px-10 py-0.5 text-[9px] font-black uppercase tracking-widest text-surface-0 shadow-lift"
        >
          Popular
        </span>
      )}

      {justSettled && (
        <span
          data-testid="package-settled-badge"
          className="absolute left-3 top-3 flex h-6 w-6 animate-settle-pop items-center justify-center rounded-full bg-success/20 text-xs font-black text-success ring-1 ring-success/40"
        >
          <span aria-hidden="true">✓</span>
          <span className="sr-only">Purchase settled</span>
        </span>
      )}

      <div className="flex items-center justify-between gap-4">
        <CandyIcon
          name={pkg.highlight ? "gift" : "coin"}
          className="h-12 w-12 shrink-0 drop-shadow-[0_4px_6px_rgba(0,0,0,0.35)] group-hover:animate-wiggle"
        />
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold text-ink">{pkg.name}</p>
          <p className="mt-1 text-sm font-semibold text-gc">{pkg.gc}</p>
          <p className="text-xs font-medium text-sc-unplayed">{pkg.sc}</p>
        </div>
        <button
          type="button"
          onClick={onBuy}
          disabled={disabled}
          className="btn-candy btn-green min-h-11 min-w-24 shrink-0 px-4 py-2.5 text-base"
        >
          {buying ? (
            <span className="flex items-center justify-center gap-2">
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-surface-0/40 border-t-surface-0"
              />
              BUYING…
            </span>
          ) : (
            `BUY ${pkg.price}`
          )}
        </button>
      </div>
    </li>
  );
}
