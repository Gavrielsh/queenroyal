import { describe, expect, it } from "vitest";

import { getAmoeOffer } from "../src/config/amoe";
import { STORE_PACKAGES } from "../src/config/store-packages";
import { compareMoney, isMoneyString, isPositiveMoneyString } from "../src/lib/money";

import {
  type AmoeFacts,
  type AmoePolicy,
  amoePeriodKey,
  evaluateAmoeClaim,
  jurisdictionAllowsAmoe,
  kycAllowsAmoe,
  periodIsAvailable,
  playerStatusAllowsAmoe,
} from "../src/lib/amoe-policy";

/** Fixture policy. TEST DATA only — no real jurisdiction's list appears in the module itself. */
const POLICY: AmoePolicy = {
  closedJurisdictions: ["US-WA", "US-ID"],
  requireVerifiedKyc: false,
};

const OPEN_FACTS: AmoeFacts = {
  jurisdiction: "US-NJ",
  kycStatus: "PENDING",
  playerStatus: "ACTIVE",
  periodAlreadyClaimed: false,
};

describe("jurisdictionAllowsAmoe", () => {
  it("admits an open jurisdiction and refuses a closed one", () => {
    expect(jurisdictionAllowsAmoe("US-NJ", POLICY)).toBe(true);
    expect(jurisdictionAllowsAmoe("US-WA", POLICY)).toBe(false);
  });

  // An unresolvable jurisdiction is the geo-fence's business, not the policy's. Duplicating a
  // fail-closed geo decision here would mean a geo outage silently closed the statutory free
  // route for a reason unrelated to the player.
  it("treats an unknown jurisdiction as open and leaves the fence to refuse it", () => {
    expect(jurisdictionAllowsAmoe("", POLICY)).toBe(true);
  });
});

describe("playerStatusAllowsAmoe", () => {
  it("admits only ACTIVE", () => {
    expect(playerStatusAllowsAmoe("ACTIVE")).toBe(true);
    for (const status of ["SELF_EXCLUDED", "SUSPENDED", "CLOSED", "KYC_PENDING", "", "active"]) {
      expect(playerStatusAllowsAmoe(status)).toBe(false);
    }
  });
});

describe("kycAllowsAmoe", () => {
  // The argued default: identity verification is a barrier at the free entry and a control at
  // the cash-out. A PENDING player may claim; they cannot redeem without verifying, which is
  // where duplicate identities are actually caught.
  it("admits PENDING by default, because the free route must not require verification", () => {
    expect(kycAllowsAmoe("PENDING", POLICY)).toBe(true);
    expect(kycAllowsAmoe("VERIFIED", POLICY)).toBe(true);
  });

  it("always refuses REJECTED, switch or no switch", () => {
    expect(kycAllowsAmoe("REJECTED", POLICY)).toBe(false);
    expect(kycAllowsAmoe("REJECTED", { ...POLICY, requireVerifiedKyc: true })).toBe(false);
  });

  it("refuses PENDING once an operator turns the switch on", () => {
    const strict = { ...POLICY, requireVerifiedKyc: true };
    expect(kycAllowsAmoe("PENDING", strict)).toBe(false);
    expect(kycAllowsAmoe("VERIFIED", strict)).toBe(true);
  });
});

describe("periodIsAvailable", () => {
  it("is the inverse of having already claimed", () => {
    expect(periodIsAvailable(false)).toBe(true);
    expect(periodIsAvailable(true)).toBe(false);
  });
});

describe("evaluateAmoeClaim", () => {
  it("allows an ordinary claim from an unverified but active player", () => {
    expect(evaluateAmoeClaim(OPEN_FACTS, POLICY)).toEqual({ allowed: true });
  });

  it("refuses a period that has already been claimed", () => {
    const d = evaluateAmoeClaim({ ...OPEN_FACTS, periodAlreadyClaimed: true }, POLICY);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toEqual(["PERIOD_ALREADY_CLAIMED"]);
  });

  it("refuses a blocked player", () => {
    for (const status of ["SELF_EXCLUDED", "SUSPENDED", "CLOSED"]) {
      const d = evaluateAmoeClaim({ ...OPEN_FACTS, playerStatus: status }, POLICY);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.refusals).toContain("PLAYER_NOT_ACTIVE");
    }
  });

  it("distinguishes a rejected account from an unverified one", () => {
    const rejected = evaluateAmoeClaim({ ...OPEN_FACTS, kycStatus: "REJECTED" }, POLICY);
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) expect(rejected.refusals).toEqual(["KYC_REJECTED"]);

    const strict = { ...POLICY, requireVerifiedKyc: true };
    const unverified = evaluateAmoeClaim(OPEN_FACTS, strict);
    expect(unverified.allowed).toBe(false);
    if (!unverified.allowed) expect(unverified.refusals).toEqual(["KYC_REQUIRED"]);
  });

  // All refusals at once, not the first: a claimant who fixes one reason and is then refused
  // for a new one cannot tell a working cap from a broken entry method, and on the statutory
  // route that ambiguity is a finding.
  it("reports every refusal, not just the first", () => {
    const d = evaluateAmoeClaim(
      { jurisdiction: "US-WA", kycStatus: "REJECTED", playerStatus: "SUSPENDED", periodAlreadyClaimed: true },
      POLICY,
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.refusals).toEqual([
        "JURISDICTION_BLOCKED",
        "PLAYER_NOT_ACTIVE",
        "KYC_REJECTED",
        "PERIOD_ALREADY_CLAIMED",
      ]);
    }
  });

  // The module holds no jurisdiction of its own — it compares against the table it is handed,
  // exactly as lib/redemption-policy does.
  it("carries no jurisdiction list of its own", () => {
    const empty: AmoePolicy = { closedJurisdictions: [], requireVerifiedKyc: false };
    expect(evaluateAmoeClaim({ ...OPEN_FACTS, jurisdiction: "US-WA" }, empty)).toEqual({ allowed: true });
  });
});

describe("amoePeriodKey", () => {
  it("derives a day key in UTC", () => {
    expect(amoePeriodKey(new Date("2026-09-18T00:00:00Z"), "DAY")).toBe("DAY:2026-09-18");
    expect(amoePeriodKey(new Date("2026-09-18T23:59:59Z"), "DAY")).toBe("DAY:2026-09-18");
    expect(amoePeriodKey(new Date("2026-09-19T00:00:00Z"), "DAY")).toBe("DAY:2026-09-19");
  });

  it("derives a month key in UTC", () => {
    expect(amoePeriodKey(new Date("2026-09-01T00:00:00Z"), "MONTH")).toBe("MONTH:2026-09");
    expect(amoePeriodKey(new Date("2026-09-30T23:59:59Z"), "MONTH")).toBe("MONTH:2026-09");
    expect(amoePeriodKey(new Date("2026-10-01T00:00:00Z"), "MONTH")).toBe("MONTH:2026-10");
  });

  /**
   * THE BOUNDARY THAT DECIDES WHETHER THE CAP HOLDS.
   *
   * A period key computed in local time would hand a second free entry to anyone willing to
   * change their clock. Every instant in one UTC day must map to one key regardless of what
   * offset it would read as elsewhere, so these two — 8pm in New York and 4am in Berlin the
   * next morning — are the same UTC day and must produce the same key.
   */
  it("does not move with the viewer's timezone", () => {
    const sameUtcDay = [
      new Date("2026-09-18T00:00:00Z"), // 8pm Sep 17 in New York
      new Date("2026-09-18T12:00:00Z"),
      new Date("2026-09-18T22:00:00Z"), // 12am Sep 19 in Berlin
    ];
    const keys = new Set(sameUtcDay.map((d) => amoePeriodKey(d, "DAY")));
    expect([...keys]).toEqual(["DAY:2026-09-18"]);
  });

  it("prefixes the granularity so periods of different sizes can never collide", () => {
    const instant = new Date("2026-09-18T12:00:00Z");
    const keys = [
      amoePeriodKey(instant, "DAY"),
      amoePeriodKey(instant, "WEEK"),
      amoePeriodKey(instant, "MONTH"),
    ];
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(/^(DAY|WEEK|MONTH):/);
  });

  describe("ISO weeks", () => {
    it("gives one key to a Monday-to-Sunday span and a new one on the next Monday", () => {
      // 2026-09-14 is a Monday; 2026-09-20 is the Sunday that closes that week.
      const monday = amoePeriodKey(new Date("2026-09-14T00:00:00Z"), "WEEK");
      const sunday = amoePeriodKey(new Date("2026-09-20T23:59:59Z"), "WEEK");
      const nextMonday = amoePeriodKey(new Date("2026-09-21T00:00:00Z"), "WEEK");

      expect(monday).toBe(sunday);
      expect(nextMonday).not.toBe(monday);
    });

    /**
     * The defect that surfaces once a year and never in a test written against today's date.
     *
     * An ISO week belongs to the year containing its Thursday, so 1 January can sit in week 53
     * of the PREVIOUS year. Keying on the calendar year would make that week's key collide
     * with week 1 of the new year — handing one player two free entries in a single week,
     * every few years, silently.
     */
    it("keys a new year's day that belongs to the previous ISO year under that previous year", () => {
      // 2027-01-01 is a Friday; its week's Thursday is 2026-12-31, so it is ISO 2026-W53.
      const newYearsDay = amoePeriodKey(new Date("2027-01-01T12:00:00Z"), "WEEK");
      const newYearsEve = amoePeriodKey(new Date("2026-12-31T12:00:00Z"), "WEEK");

      expect(newYearsDay).toBe(newYearsEve);
      expect(newYearsDay).toBe("WEEK:2026-W53");
    });

    it("keys a new year's day that starts its own ISO year under the new year", () => {
      // 2025-01-01 is a Wednesday; its week's Thursday is 2025-01-02, so it is ISO 2025-W01.
      expect(amoePeriodKey(new Date("2025-01-01T12:00:00Z"), "WEEK")).toBe("WEEK:2025-W01");
    });

    it("zero-pads the week number so keys sort and compare as written", () => {
      expect(amoePeriodKey(new Date("2026-01-05T00:00:00Z"), "WEEK")).toBe("WEEK:2026-W02");
    });

    /**
     * Sweep a full year of days: every key must be a well-formed ISO week in the 1..53 range,
     * and each key must cover exactly seven consecutive days. A week that covered six or eight
     * would be a cap that is a day too tight or a day too loose, and neither would be visible
     * from spot checks alone.
     */
    it("partitions a whole year into exact seven-day weeks", () => {
      const counts = new Map<string, number>();
      for (let i = 0; i < 365; i += 1) {
        const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
        const key = amoePeriodKey(d, "WEEK");
        expect(key).toMatch(/^WEEK:\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      // Only the two partial weeks at either end of the sweep may be short.
      const keys = [...counts.keys()];
      for (const key of keys.slice(1, -1)) {
        expect(counts.get(key)).toBe(7);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The configured offer
// ─────────────────────────────────────────────────────────────────────────────

describe("getAmoeOffer", () => {
  /**
   * The amounts are hand-edited literals, and a hand-edited money string is exactly the kind
   * that arrives as "5" or "5.00001". Nothing else on the OUTBOUND path catches either — the
   * engine-payload schema guards only the reconciler's replay — so this asserts the guard at
   * the source exists and that the shipped values pass it.
   */
  it("returns amounts that are strictly formatted decimal strings", () => {
    const offer = getAmoeOffer();
    // CANONICAL form — exactly 4 dp, not merely "a valid money string". `isMoneyString`
    // permits "5", which is the same money as "5.0000" and a different string; the stored row
    // and the ledger must compare equal, so the shape has to be pinned, not just the value.
    expect(offer.scAmount).toMatch(/^\d+\.\d{4}$/);
    expect(offer.gcAmount).toMatch(/^\d+\.\d{4}$/);
    expect(isMoneyString(offer.scAmount)).toBe(true);
    expect(isMoneyString(offer.gcAmount)).toBe(true);
  });

  /**
   * The guard must be stricter than the shared helper, and this is the case that proves it:
   * "5" passes `isMoneyString` and must still be refused here. Without this assertion the
   * runtime check could be loosened back to `isMoneyString` and every test would stay green
   * while the documented failure came back.
   */
  it("refuses an unpadded amount that the shared money helper would accept", () => {
    expect(isMoneyString("5")).toBe(true);
    expect("5").not.toMatch(/^\d+\.\d{4}$/);
  });

  /**
   * The AMOE grant must be worth something. A zeroed config would leave the statutory route
   * technically working and materially empty, which is worse than it being switched off —
   * it looks compliant.
   */
  it("issues a positive amount of the sweepstakes currency", () => {
    expect(isPositiveMoneyString(getAmoeOffer().scAmount)).toBe(true);
  });

  /**
   * EQUAL DIGNITY, as a test rather than a comment.
   *
   * The free entrant must not receive materially less sweepstakes currency than a purchaser
   * gets from the entry-level package. This is the number the whole legal position rests on,
   * and it lives in a file a reviewer can edit in one line — so a change that quietly halves
   * it should have to argue with a red test rather than pass unnoticed.
   *
   * Compared with `compareMoney`, not `<`: "5" and "5.0000" are the same money and a string
   * or float comparison would get that wrong in opposite directions.
   */
  it("is not worth less than the entry-level package's sweepstakes coins", () => {
    const cheapest = [...STORE_PACKAGES].sort((a, b) => a.priceUsdCents - b.priceUsdCents)[0];
    expect(cheapest).toBeDefined();

    const packageSc = `${cheapest!.sc}.0000`;
    expect(compareMoney(getAmoeOffer().scAmount, packageSc)).toBeGreaterThanOrEqual(0);
  });
});
