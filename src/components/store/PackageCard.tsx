"use client";

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
      className={`group relative overflow-hidden rounded-card border p-4 transition duration-300 ${
        pkg.highlight
          ? "border-gc/40 bg-gradient-to-br from-surface-2 via-surface-1 to-surface-1 shadow-glow-gc"
          : "border-edge bg-surface-1/80"
      } ${disabled ? "" : "hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-lift"}`}
    >
      {pkg.highlight && (
        <span
          aria-hidden="true"
          className="absolute -right-9 top-4 rotate-45 bg-gradient-to-r from-gc to-yellow-400 px-10 py-0.5 text-[9px] font-black uppercase tracking-widest text-surface-0 shadow-lift"
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
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{pkg.name}</p>
          <p className="mt-1 text-sm font-semibold text-gc">{pkg.gc}</p>
          <p className="text-xs font-medium text-sc-unplayed">{pkg.sc}</p>
        </div>
        <button
          type="button"
          onClick={onBuy}
          disabled={disabled}
          className="min-w-24 shrink-0 rounded-control bg-gradient-to-r from-sc-unplayed to-teal-400 px-4 py-3 text-sm font-black tracking-wide text-surface-0 shadow-glow-sc transition active:scale-[0.97] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
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
