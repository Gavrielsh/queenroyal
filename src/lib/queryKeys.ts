/**
 * Strictly-typed React Query key factory for Zone 3. Keys are `readonly` tuples so the exact
 * same identity is used wherever a query is read, invalidated, or seeded — no stringly-typed
 * drift between call sites.
 */
export const walletKeys = {
  /** Root for all wallet-scoped queries (use for broad invalidation). */
  all: ["wallet"] as const,
  /** The authoritative balances snapshot. */
  balances: () => ["wallet", "balances"] as const,
} as const;

/** Meta-game reads (Daily Wheel status, …). Never money truth — the wallet is walletKeys. */
export const metaKeys = {
  dailyBonus: () => ["meta", "dailyBonus"] as const,
} as const;
