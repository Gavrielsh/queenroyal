/**
 * Typed bridge to the design tokens defined in src/app/globals.css (@theme).
 *
 * Components pick money colors THROUGH this map — never ad-hoc palette classes — so a
 * currency family can never render with the wrong accent. The class names resolve to the
 * `--color-*` tokens Tailwind 4 generates utilities for.
 *
 * Palette direction: Midnight Sapphire & Crimson (M3-T3). GC reads gold, SC reads teal —
 * the two currencies sit ~130° apart on the hue wheel so they stay visually distinct at
 * any scale. Gold doubles as the site's one CTA color (`--color-cta`); ruby (`--color-highlight`)
 * is reserved for wins/highlights/"HOT" badges and is never used for errors — destructive
 * states use `--color-danger`, a coral hue deliberately far from ruby on the wheel.
 */

export type CurrencyFamily = "gc" | "scUnplayed" | "scRedeemable";

/** Text accent per currency family (chips, amounts, labels). */
export const CURRENCY_TEXT_CLASS: Readonly<Record<CurrencyFamily, string>> = {
  gc: "text-gc",
  scUnplayed: "text-sc-unplayed",
  scRedeemable: "text-sc-redeemable",
};

/** Human labels per currency family, matching the sweeps-model vocabulary. */
export const CURRENCY_LABEL: Readonly<Record<CurrencyFamily, string>> = {
  gc: "GC",
  scUnplayed: "SC Unplayed",
  scRedeemable: "SC Redeemable",
};
