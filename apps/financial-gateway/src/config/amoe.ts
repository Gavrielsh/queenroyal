import type { AmoeGrantPeriod, AmoePolicy } from "../lib/amoe-policy";

/**
 * The free-entry offer — THE DATA, kept out of the policy that applies it.
 *
 * Same split as config/redemption-caps: lib/amoe-policy holds no figure of its own and
 * compares against whatever table it is handed. This is that table, and it lives in config/
 * because what the free route offers is a compliance decision that changes by legal review,
 * not by release. Editing it is a data change a reviewer can read in one diff.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EQUAL DIGNITY IS A PROPERTY OF THESE NUMBERS
 * ─────────────────────────────────────────────────────────────────────────────
 * A sweepstakes stops being a sweepstakes and becomes a lottery when the free route is not a
 * real alternative to paying. That is decided here, in `scAmount`, more than anywhere else in
 * the codebase: an AMOE grant materially smaller than what a purchaser receives per period is
 * the single most likely way this platform loses its legal footing, and it would happen by
 * someone editing one string.
 *
 * `scAmount` below is pitched against the store catalog's entry-level package
 * (config/store-packages) deliberately. If that catalog changes, this number is part of the
 * change.
 *
 * THE VALUES ARE PLACEHOLDERS PENDING COMPLIANCE SIGN-OFF, and conservative in the direction
 * that matters: too generous a free grant costs promotional margin, while too mean a one is a
 * regulator's letter. Nothing in the code depends on these particular numbers.
 */
export interface AmoeOffer {
  /** Sweeps Coins issued per successful claim, as a decimal string. */
  scAmount: string;
  /** Gold Coins issued alongside. "0.0000" is the ordinary AMOE shape. */
  gcAmount: string;
  /** How often one person may claim. */
  period: AmoeGrantPeriod;
}

const AMOE_OFFER: AmoeOffer = {
  // Matched to the SC in the entry-level store package, so the free entrant and the paying
  // one receive the same sweepstakes currency for the same period.
  scAmount: "5.0000",
  // AMOE yields SWEEPS COINS. Gold Coins are entertainment-only currency with no prize
  // eligibility, so granting them through the free route would pad the headline number
  // without improving the entry — which is the shape of an offer designed to look equal
  // rather than be equal.
  gcAmount: "0.0000",
  period: "DAY",
};

export function getAmoeOffer(): AmoeOffer {
  return AMOE_OFFER;
}

/**
 * The statutory disclosure served at `GET /api/amoe`.
 *
 * Public and unauthenticated by necessity: a free entry method that can only be discovered
 * from inside a logged-in account is not meaningfully available, and "no purchase necessary"
 * has to be readable by someone who has not purchased — including a regulator with no
 * account at all.
 *
 * PLACEHOLDER TEXT PENDING COUNSEL. The structure is the deliverable here; the wording,
 * the mailing address and the jurisdiction list are for the operator's lawyers to set. The
 * shape is kept explicit rather than free-form markdown so a reviewer can see at a glance
 * that every required element is present.
 */
export interface AmoeInstructions {
  readonly title: string;
  readonly noPurchaseNecessary: string;
  readonly howToEnter: readonly string[];
  readonly grant: { readonly scAmount: string; readonly gcAmount: string; readonly period: AmoeGrantPeriod };
  readonly limits: readonly string[];
  readonly eligibility: readonly string[];
  readonly mailingAddress: readonly string[];
  readonly lastUpdated: string;
}

export function getAmoeInstructions(): AmoeInstructions {
  const offer = getAmoeOffer();
  return {
    title: "Free Entry — No Purchase Necessary",
    noPurchaseNecessary:
      "No purchase is necessary to enter or win. A purchase will not increase your chances of winning. " +
      "Sweeps Coins obtained through the free entry method carry the same play and prize eligibility as " +
      "Sweeps Coins received with a Gold Coin purchase.",
    howToEnter: [
      "Request a free entry from your account, which issues your Sweeps Coins immediately.",
      "Or mail a hand-written request to the address below. Mailed requests are fulfilled to the " +
        "account matching the email address on the request.",
      "Each request must be hand-written and separately stamped and mailed. Mechanically reproduced " +
        "requests are not accepted.",
    ],
    grant: { scAmount: offer.scAmount, gcAmount: offer.gcAmount, period: offer.period },
    limits: [
      `One free entry per person per ${offer.period.toLowerCase()}, measured in UTC.`,
      "Multiple accounts operated by one person do not increase the number of entries that person " +
        "may receive, and may result in all such accounts being closed.",
    ],
    eligibility: [
      "You must hold an account in good standing that has not been closed, suspended, or self-excluded.",
      "You must be located in a jurisdiction where the sweepstakes is offered.",
      "Identity verification is not required to request a free entry. It is required to redeem any " +
        "prize, by the same rules that apply to purchased Sweeps Coins.",
    ],
    mailingAddress: [
      "QueenRoyal Free Entry",
      "PO Box 0000",
      "City, ST 00000",
      "United States",
    ],
    lastUpdated: "2026-09-18",
  };
}

/**
 * The free-entry gate's data. Mirrors getRedemptionCaps(): a function, so a future env- or
 * DB-backed source is a drop-in change.
 *
 * `requireVerifiedKyc` is FALSE, and that default is an argued position rather than an
 * oversight — see the long note in lib/amoe-policy. In short: the identity barrier belongs at
 * the cash-out, where redemption already enforces it, not at the statutory free entry, where
 * it excludes legitimate entrants and costs a multi-accounter nothing.
 */
const AMOE_POLICY: AmoePolicy = {
  // The same states named closed in config/redemption-caps. Listed again rather than derived
  // from that table: the two answer different questions ("may money leave here?" versus "may
  // an entry be offered here?") and a future divergence between them should be a visible edit,
  // not a silent inheritance.
  closedJurisdictions: ["US-WA", "US-ID", "US-NV", "US-MI"],
  requireVerifiedKyc: false,
};

export function getAmoePolicy(): AmoePolicy {
  return AMOE_POLICY;
}
