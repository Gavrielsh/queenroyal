import type { RedemptionCapTable } from "../lib/redemption-policy";

/**
 * Redemption limits — THE DATA, kept out of the policy that applies it.
 *
 * lib/redemption-policy contains no figure of its own by design: it compares against whatever
 * table it is handed. This is that table, and it lives in config/ for the same reason the
 * store catalog does — sweepstakes prize limits differ per state and change by legislature,
 * not by release. Editing a cap here is a data change a compliance reviewer can read in one
 * diff, not a change to business logic that has to be re-reasoned about.
 *
 * `null` for a jurisdiction is a POSITIVE statement that redemption is closed there, which is
 * deliberately different from the jurisdiction being absent (absent → the default applies).
 *
 * THE VALUES BELOW ARE PLACEHOLDERS PENDING COMPLIANCE SIGN-OFF. They are deliberately
 * conservative — a cap that is too low refuses a legitimate redemption, which is a support
 * ticket; a cap that is too high pays out past a statutory ceiling, which is a regulator's
 * letter. Nothing in the code depends on these particular numbers.
 */
const REDEMPTION_CAPS: RedemptionCapTable = {
  default: {
    minimumAmount: "50.0000",
    maximumPerRequest: "2500.0000",
    dailyCap: "5000.0000",
    monthlyCap: "20000.0000",
  },
  byJurisdiction: {
    // States where the sweepstakes model is not offered at all. The geo fence already blocks
    // these at the perimeter; naming them here too means a redemption is refused even if it
    // somehow arrives from behind a misconfigured edge — two independent controls, which is
    // the point of defence in depth.
    "US-WA": null,
    "US-ID": null,
    "US-NV": null,
    "US-MI": null,
  },
};

/** The active cap table. A function, so a future env/DB-backed source is a drop-in change. */
export function getRedemptionCaps(): RedemptionCapTable {
  return REDEMPTION_CAPS;
}
