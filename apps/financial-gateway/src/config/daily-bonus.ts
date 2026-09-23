import { isMoneyString, isPositiveMoneyString } from "../lib/money";

/**
 * The Daily Wheel offer — a discretionary marketing grant (engine channel BONUS).
 *
 * THE DRAW IS THE SERVER'S. The browser receives the slices (to draw the wheel) and later the
 * id of the slice it landed on; it never chooses one and never sends an amount. Weights are
 * relative integers. They are published with the slices so the Sweepstakes Rules and the UI
 * can disclose the odds — a prize wheel whose odds are secret is the kind of promotion a
 * regulator asks about first.
 *
 * Amounts are decimal STRINGS forwarded verbatim to Zone 1 (G2): "0" means "this currency is
 * not granted by this slice". Any SC is credited as SC_UNPLAYED — the engine cannot mint
 * redeemable SC through a promo grant.
 */
export interface WheelSlice {
  id: string;
  gcAmount: string;
  scAmount: string;
  weight: number;
  featured?: boolean;
}

export interface DailyBonusOffer {
  slices: readonly WheelSlice[];
  /** IANA zone the gaming day is measured in. The day resets at local midnight there. */
  timeZone: string;
}

const OFFER: DailyBonusOffer = {
  timeZone: "America/New_York",
  slices: [
    { id: "s1", gcAmount: "5000", scAmount: "0", weight: 18 },
    { id: "s2", gcAmount: "0", scAmount: "0.2000", weight: 14 },
    { id: "s3", gcAmount: "10000", scAmount: "0", weight: 14 },
    { id: "s4", gcAmount: "0", scAmount: "0.5000", weight: 8 },
    { id: "s5", gcAmount: "2500", scAmount: "0", weight: 18 },
    { id: "s6", gcAmount: "25000", scAmount: "1.0000", weight: 2, featured: true },
    { id: "s7", gcAmount: "7500", scAmount: "0", weight: 12 },
    { id: "s8", gcAmount: "0", scAmount: "0.3000", weight: 8 },
    { id: "s9", gcAmount: "15000", scAmount: "0", weight: 5 },
    { id: "s10", gcAmount: "0", scAmount: "1.0000", weight: 1 },
  ],
};

/** Throws at first use if the configured offer is malformed — a bad wheel must never ship. */
export function validateDailyBonusOffer(offer: DailyBonusOffer): void {
  if (offer.slices.length < 2) throw new Error("daily bonus: at least two slices are required");
  const ids = new Set<string>();
  for (const slice of offer.slices) {
    if (ids.has(slice.id)) throw new Error(`daily bonus: duplicate slice id ${slice.id}`);
    ids.add(slice.id);
    if (!isMoneyString(slice.gcAmount) || !isMoneyString(slice.scAmount)) {
      throw new Error(`daily bonus: slice ${slice.id} amounts must be decimal strings`);
    }
    if (!isPositiveMoneyString(slice.gcAmount) && !isPositiveMoneyString(slice.scAmount)) {
      throw new Error(`daily bonus: slice ${slice.id} grants nothing — every slice must be a win`);
    }
    if (!Number.isInteger(slice.weight) || slice.weight <= 0) {
      throw new Error(`daily bonus: slice ${slice.id} weight must be a positive integer`);
    }
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: offer.timeZone });
  } catch {
    throw new Error(`daily bonus: unknown time zone ${offer.timeZone}`);
  }
}

let validated = false;

export function getDailyBonusOffer(): DailyBonusOffer {
  if (!validated) {
    validateDailyBonusOffer(OFFER);
    validated = true;
  }
  return OFFER;
}
