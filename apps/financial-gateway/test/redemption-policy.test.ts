import { describe, expect, it } from "vitest";

import { compareMoney, moneyFromUnits, moneyUnits, sumMoney } from "../src/lib/money";
import {
  type RedemptionCapTable,
  type RedemptionCaps,
  type RedemptionFacts,
  capsFor,
  evaluateRedemption,
  kycAllowsRedemption,
  meetsMinimum,
  playerStatusAllowsRedemption,
  playthroughDischarged,
  withinDailyCap,
  withinMonthlyCap,
  withinPerRequestCap,
  withinPeriodCap,
} from "../src/lib/redemption-policy";

/**
 * Fixture caps. These are TEST DATA and nothing more — no real jurisdiction's figures appear
 * in the module under test, which is the property the jurisdiction suite below asserts.
 */
const CAPS: RedemptionCaps = {
  minimumAmount: "50.0000",
  maximumPerRequest: "2500.0000",
  dailyCap: "5000.0000",
  monthlyCap: "20000.0000",
};

const TABLE: RedemptionCapTable = {
  default: CAPS,
  byJurisdiction: {
    // A stricter jurisdiction.
    "US-NY": { minimumAmount: "100.0000", maximumPerRequest: "600.0000", dailyCap: "600.0000", monthlyCap: "2000.0000" },
    // Closed outright — encoded as an explicit null, not as an absent key.
    "US-WA": null,
    "US-ID": null,
  },
};

/** A request that passes every rule, so each test can break exactly one thing. */
function clean(overrides: Partial<RedemptionFacts> = {}): RedemptionFacts {
  return {
    jurisdiction: "US-NJ",
    kycStatus: "VERIFIED",
    playerStatus: "ACTIVE",
    playthroughOutstanding: "0",
    amount: "100.0000",
    redeemedToday: "0",
    redeemedThisMonth: "0",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("exact decimal primitives (the float ban's foundation)", () => {
  it("compares across differing scales", () => {
    expect(compareMoney("10", "10.0000")).toBe(0);
    expect(compareMoney("10.00", "10.0")).toBe(0);
    expect(compareMoney("9.9999", "10")).toBe(-1);
    expect(compareMoney("10.0001", "10")).toBe(1);
  });

  it("adds without the classic float error", () => {
    // The canonical demonstration: 0.1 + 0.2 is 0.30000000000000004 in IEEE-754.
    expect(sumMoney("0.1", "0.2")).toBe("0.3000");
    expect(sumMoney("1.5", "2.5000", "0.0001")).toBe("4.0001");
  });

  it("is exact at the 4th decimal place, where a float would round", () => {
    // 0.1 summed ten times is 0.9999999999999999 in floating point.
    expect(sumMoney(...Array<string>(10).fill("0.1"))).toBe("1.0000");
    expect(sumMoney("1000000000.0001", "0.0001")).toBe("1000000000.0002");
  });

  it("round-trips through the integer representation", () => {
    expect(moneyUnits("125.5000").toString()).toBe("1255000");
    expect(moneyUnits("125.5").toString()).toBe("1255000");
    expect(moneyFromUnits(1255000n)).toBe("125.5000");
    expect(moneyFromUnits(1n)).toBe("0.0001");
    expect(moneyFromUnits(0n)).toBe("0.0000");
  });

  it("refuses a malformed amount rather than coercing it", () => {
    expect(() => moneyUnits("1.2.3")).toThrow(/not a money string/);
    expect(() => moneyUnits("-5")).toThrow(/not a money string/);
    expect(() => moneyUnits("1e3")).toThrow(/not a money string/);
    expect(() => moneyUnits("")).toThrow(/not a money string/);
  });

  it("refuses a sum that would overflow the ledger's capacity", () => {
    const nearMax = "99999999999999.9999"; // 14 integer digits — the ledger's ceiling
    expect(() => sumMoney(nearMax, "0.0001")).toThrow(/exceeds the ledger's capacity/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("rule: KYC", () => {
  it("admits only VERIFIED", () => {
    expect(kycAllowsRedemption("VERIFIED")).toBe(true);
    for (const s of ["PENDING", "REJECTED", "verified", "", "UNKNOWN"]) {
      expect(kycAllowsRedemption(s)).toBe(false);
    }
  });

  it("refuses the redemption", () => {
    const d = evaluateRedemption(clean({ kycStatus: "PENDING" }), TABLE);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toContain("KYC_NOT_VERIFIED");
  });
});

describe("rule: player status", () => {
  it("admits only ACTIVE", () => {
    expect(playerStatusAllowsRedemption("ACTIVE")).toBe(true);
    for (const s of ["SUSPENDED", "SELF_EXCLUDED", "KYC_PENDING", "CLOSED", "active", ""]) {
      expect(playerStatusAllowsRedemption(s)).toBe(false);
    }
  });

  it.each(["SUSPENDED", "SELF_EXCLUDED", "CLOSED", "KYC_PENDING"])("refuses a %s player", (status) => {
    const d = evaluateRedemption(clean({ playerStatus: status }), TABLE);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toContain("PLAYER_NOT_ACTIVE");
  });
});

describe("rule: playthrough", () => {
  it("treats every spelling of zero as discharged", () => {
    for (const z of ["0", "0.0", "0.0000", "00.00"]) expect(playthroughDischarged(z)).toBe(true);
  });

  it("refuses on any outstanding amount, down to the last unit", () => {
    expect(playthroughDischarged("0.0001")).toBe(false);
    const d = evaluateRedemption(clean({ playthroughOutstanding: "0.0001" }), TABLE);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toContain("PLAYTHROUGH_OUTSTANDING");
  });
});

describe("rule: minimum amount", () => {
  it("is inclusive at the boundary", () => {
    expect(meetsMinimum("50.0000", CAPS)).toBe(true);
    expect(meetsMinimum("50", CAPS)).toBe(true); // scale must not change the answer
    expect(meetsMinimum("49.9999", CAPS)).toBe(false);
  });

  it("refuses below the floor", () => {
    const d = evaluateRedemption(clean({ amount: "49.9999" }), TABLE);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toContain("BELOW_MINIMUM");
  });
});

describe("rule: per-request cap", () => {
  it("is inclusive at the boundary", () => {
    expect(withinPerRequestCap("2500.0000", CAPS)).toBe(true);
    expect(withinPerRequestCap("2500.0001", CAPS)).toBe(false);
  });

  it("refuses above the ceiling", () => {
    const d = evaluateRedemption(clean({ amount: "2500.0001" }), TABLE);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toContain("ABOVE_PER_REQUEST_CAP");
  });
});

describe("rule: period caps", () => {
  it("measures the request PLUS what the period already holds", () => {
    // Each request is individually under the per-request cap; together they breach the day.
    expect(withinDailyCap("2500.0000", "2500.0000", CAPS)).toBe(true); // exactly on the cap
    expect(withinDailyCap("2500.0001", "2500.0000", CAPS)).toBe(false); // one unit over
    expect(withinMonthlyCap("1.0000", "19999.0000", CAPS)).toBe(true);
    expect(withinMonthlyCap("1.0001", "19999.0000", CAPS)).toBe(false);
  });

  it("withinPeriodCap — the shared helper both period rules delegate to", () => {
    expect(withinPeriodCap("10.0000", "0", "10.0000")).toBe(true); // exactly on the cap
    expect(withinPeriodCap("10.0001", "0", "10.0000")).toBe(false);
    expect(withinPeriodCap("0.0001", "9.9999", "10.0000")).toBe(true);
    expect(withinPeriodCap("0.0002", "9.9999", "10.0000")).toBe(false);
    // A period with nothing used yet behaves as the per-request check would.
    expect(withinPeriodCap("10", "0.0000", "10.0000")).toBe(true);
  });

  it("is not satisfiable by splitting a request into smaller ones", () => {
    // The defect a request-only check would have: two requests, each legal alone.
    const first = evaluateRedemption(clean({ amount: "2500.0000", redeemedToday: "2500.0000" }), TABLE);
    expect(first.allowed).toBe(true);
    const second = evaluateRedemption(clean({ amount: "0.0001", redeemedToday: "5000.0000" }), TABLE);
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.refusals).toContain("DAILY_CAP_EXCEEDED");
  });

  it("reports the daily and monthly breaches independently", () => {
    const daily = evaluateRedemption(clean({ amount: "1000.0000", redeemedToday: "4500.0000" }), TABLE);
    expect(daily.allowed).toBe(false);
    if (!daily.allowed) {
      expect(daily.refusals).toContain("DAILY_CAP_EXCEEDED");
      expect(daily.refusals).not.toContain("MONTHLY_CAP_EXCEEDED");
    }

    const monthly = evaluateRedemption(clean({ amount: "1000.0000", redeemedThisMonth: "19500.0000" }), TABLE);
    expect(monthly.allowed).toBe(false);
    if (!monthly.allowed) {
      expect(monthly.refusals).toContain("MONTHLY_CAP_EXCEEDED");
      expect(monthly.refusals).not.toContain("DAILY_CAP_EXCEEDED");
    }
  });

  it("accumulates in exact decimal — a float would drift past the cap", () => {
    // 4999.9999 + 0.0001 is exactly 5000.0000, which is ON the cap and therefore allowed.
    expect(withinDailyCap("0.0001", "4999.9999", CAPS)).toBe(true);
    expect(withinDailyCap("0.0002", "4999.9999", CAPS)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("jurisdiction caps are DATA, not code", () => {
  it("falls back to the default for a jurisdiction with no entry", () => {
    expect(capsFor(TABLE, "US-NJ")).toEqual(CAPS);
  });

  it("applies a jurisdiction's own, stricter caps", () => {
    const ny = capsFor(TABLE, "US-NY");
    expect(ny?.dailyCap).toBe("600.0000");

    // The SAME request: fine in NJ, over the daily cap in NY. Only the data differs.
    const nj = evaluateRedemption(clean({ jurisdiction: "US-NJ", amount: "700.0000" }), TABLE);
    expect(nj.allowed).toBe(true);
    const inNy = evaluateRedemption(clean({ jurisdiction: "US-NY", amount: "700.0000" }), TABLE);
    expect(inNy.allowed).toBe(false);
    if (!inNy.allowed) expect(inNy.refusals).toEqual(["ABOVE_PER_REQUEST_CAP", "DAILY_CAP_EXCEEDED"]);
  });

  it("treats an explicit null as a closed jurisdiction, distinct from an absent key", () => {
    expect(capsFor(TABLE, "US-WA")).toBeNull();
    expect(capsFor(TABLE, "US-ID")).toBeNull();
    expect(capsFor(TABLE, "US-ZZ")).toEqual(CAPS); // absent → default, NOT closed
  });

  it("refuses a closed jurisdiction and reports nothing else", () => {
    // Short-circuited on purpose: with no caps resolved there is no cap to measure against,
    // so amount refusals would have to be invented.
    const d = evaluateRedemption(clean({ jurisdiction: "US-WA", amount: "999999.0000", kycStatus: "PENDING" }), TABLE);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toEqual(["JURISDICTION_NOT_PERMITTED"]);
  });

  it("normalizes casing and whitespace from the edge header", () => {
    expect(capsFor(TABLE, " us-wa ")).toBeNull();
    expect(capsFor(TABLE, "us-ny")?.dailyCap).toBe("600.0000");
  });

  it("carries no jurisdiction figures of its own: an empty table yields the default only", () => {
    const bare: RedemptionCapTable = { default: CAPS };
    expect(capsFor(bare, "US-WA")).toEqual(CAPS);
    expect(capsFor(bare, "ANYTHING")).toEqual(CAPS);
  });

  it("ignores inherited object properties when resolving a jurisdiction", () => {
    // `hasOwnProperty`, not `in`: "toString" must not resolve to Object.prototype.toString
    // and be mistaken for a configured entry.
    expect(capsFor(TABLE, "toString")).toEqual(CAPS);
    expect(capsFor(TABLE, "constructor")).toEqual(CAPS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the composed decision", () => {
  it("approves a clean request and returns the caps it was measured against", () => {
    const d = evaluateRedemption(clean(), TABLE);
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.caps).toEqual(CAPS);
  });

  it("approves exactly at every inclusive boundary at once", () => {
    const d = evaluateRedemption(
      clean({ amount: "2500.0000", redeemedToday: "2500.0000", redeemedThisMonth: "17500.0000" }),
      TABLE,
    );
    expect(d.allowed).toBe(true);
  });

  it("reports EVERY broken rule, not just the first", () => {
    const d = evaluateRedemption(
      clean({
        kycStatus: "REJECTED",
        playerStatus: "SELF_EXCLUDED",
        playthroughOutstanding: "5.0000",
        amount: "3000.0000",
        redeemedToday: "4900.0000",
        redeemedThisMonth: "19900.0000",
      }),
      TABLE,
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.refusals).toEqual([
        "KYC_NOT_VERIFIED",
        "PLAYER_NOT_ACTIVE",
        "PLAYTHROUGH_OUTSTANDING",
        "ABOVE_PER_REQUEST_CAP",
        "DAILY_CAP_EXCEEDED",
        "MONTHLY_CAP_EXCEEDED",
      ]);
      // Ordered so the headline reason is who the player is, not what they asked for.
      expect(d.refusals[0]).toBe("KYC_NOT_VERIFIED");
    }
  });

  it("throws on a malformed or non-positive amount rather than guessing", () => {
    for (const bad of ["0", "0.0000", "-10.0000", "abc", "", "1e3", "10.00001"]) {
      expect(() => evaluateRedemption(clean({ amount: bad }), TABLE)).toThrow(/positive money string/);
    }
  });

  it("is pure: the same facts give the same decision, and the inputs are untouched", () => {
    const facts = clean({ amount: "75.0000" });
    const snapshot = JSON.stringify(facts);
    const tableSnapshot = JSON.stringify(TABLE);

    const a = evaluateRedemption(facts, TABLE);
    const b = evaluateRedemption(facts, TABLE);

    expect(a).toEqual(b);
    expect(JSON.stringify(facts)).toBe(snapshot);
    expect(JSON.stringify(TABLE)).toBe(tableSnapshot);
  });

  it("does not consider the player's balance — that is the engine's answer, not ours", () => {
    // There is no balance field to supply. A redemption far beyond any plausible balance is
    // approved here and refused by the ledger, which is the correct division of authority.
    const d = evaluateRedemption(clean({ amount: "2500.0000" }), TABLE);
    expect(d.allowed).toBe(true);
    expect(Object.keys(clean())).not.toContain("balance");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the float ban, enforced against the source itself", () => {
  /**
   * A grep run once at review time proves the file was clean once. This runs on every CI
   * build, so a `parseFloat` added in six months' time fails a test instead of shipping.
   *
   * Comments are stripped first, deliberately: the module's own doc block NAMES the forbidden
   * APIs in order to prohibit them, and a check that could not tell documentation from code
   * would force that prohibition to go unwritten.
   */
  const FORBIDDEN = [
    { name: "parseFloat", re: /\bparseFloat\b/g },
    { name: "parseInt", re: /\bparseInt\b/g },
    { name: "Number", re: /\bNumber\b/g },
    { name: "toFixed", re: /\.toFixed\b/g },
    { name: "Math.*", re: /\bMath\.\w+/g },
  ];

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it.each(FORBIDDEN)("has zero instances of $name in executable code", async ({ re }) => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL("../src/lib/redemption-policy.ts", import.meta.url));
    const code = stripComments(await readFile(path, "utf8"));
    expect(code.match(re) ?? []).toEqual([]);
  });

  it("the stripper does not simply blank the file (it would pass vacuously if it did)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL("../src/lib/redemption-policy.ts", import.meta.url));
    const code = stripComments(await readFile(path, "utf8"));
    expect(code).toContain("export function evaluateRedemption");
    expect(code).toContain("compareMoney");
  });
});
