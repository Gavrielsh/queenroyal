/**
 * Fiat → Virtual currency package catalog (the code source of truth for the Cashier).
 *
 * MONEY UNITS (all integers — no floating point ever crosses to the ledger):
 *   - priceUsdCents : USD cents actually charged by the PSP.  $20.00 → 2000
 *   - gc            : Gold Coins granted (entertainment-only, whole-coin integers).
 *   - sc            : Sweeps Coins granted, credited by the engine as SC_Unplayed.
 *
 * These values are *instructions* forwarded to the True Engine. This service never stores or
 * computes the resulting balances — the engine is the sole authority.
 */

export interface StorePackageConfig {
  id: string;
  label: string;
  priceUsdCents: number;
  gc: number;
  sc: number;
}

export const STORE_PACKAGES: readonly StorePackageConfig[] = [
  { id: "pkg_starter_5", label: "$5 Starter", priceUsdCents: 500, gc: 5_000, sc: 5 },
  { id: "pkg_value_20", label: "$20 Value", priceUsdCents: 2_000, gc: 20_000, sc: 20 },
  { id: "pkg_pro_50", label: "$50 Pro", priceUsdCents: 5_000, gc: 50_000, sc: 50 },
  { id: "pkg_whale_100", label: "$100 Whale", priceUsdCents: 10_000, gc: 100_000, sc: 100 },
] as const;

const BY_ID: ReadonlyMap<string, StorePackageConfig> = new Map(STORE_PACKAGES.map((p) => [p.id, p]));

/** Look up a package by id. Returns `undefined` for unknown ids (caller handles). */
export function getPackage(id: string): StorePackageConfig | undefined {
  return BY_ID.get(id);
}
