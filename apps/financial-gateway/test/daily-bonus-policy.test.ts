import { describe, expect, it } from "vitest";

import { getDailyBonusOffer, validateDailyBonusOffer, type WheelSlice } from "../src/config/daily-bonus";
import { drawSlice, gamingDateKey, nextResetAt, previousDateKey, streakLength } from "../src/lib/daily-bonus-policy";

const ET = "America/New_York";

describe("gamingDateKey — the day resets at midnight Eastern, on the SERVER clock", () => {
  it("is still the previous day one minute before ET midnight, and the next day one minute after", () => {
    // September: EDT (UTC-4), so ET midnight is 04:00Z.
    expect(gamingDateKey(new Date("2026-09-24T03:59:00Z"), ET)).toBe("2026-09-23");
    expect(gamingDateKey(new Date("2026-09-24T04:01:00Z"), ET)).toBe("2026-09-24");
  });

  it("follows EST in winter (UTC-5)", () => {
    expect(gamingDateKey(new Date("2026-01-15T04:30:00Z"), ET)).toBe("2026-01-14");
    expect(gamingDateKey(new Date("2026-01-15T05:30:00Z"), ET)).toBe("2026-01-15");
  });
});

describe("previousDateKey", () => {
  it.each([
    ["2026-03-01", "2026-02-28"],
    ["2028-03-01", "2028-02-29"],
    ["2027-01-01", "2026-12-31"],
    ["2026-09-23", "2026-09-22"],
  ])("%s → %s", (input, expected) => {
    expect(previousDateKey(input)).toBe(expected);
  });
});

describe("nextResetAt", () => {
  it("is the next ET midnight — 04:00Z in summer, 05:00Z in winter", () => {
    expect(nextResetAt(new Date("2026-09-23T15:00:00Z"), ET).toISOString()).toBe("2026-09-24T04:00:00.000Z");
    expect(nextResetAt(new Date("2026-01-15T12:00:00Z"), ET).toISOString()).toBe("2026-01-16T05:00:00.000Z");
  });

  it("is correct across the autumn DST change (a 25-hour day)", () => {
    // 2026-11-01 is the fall-back day; its end is 2026-11-02 05:00Z.
    expect(nextResetAt(new Date("2026-11-01T12:00:00Z"), ET).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("drawSlice — weighted, server-side", () => {
  const slices: WheelSlice[] = [
    { id: "a", gcAmount: "1", scAmount: "0", weight: 3 },
    { id: "b", gcAmount: "2", scAmount: "0", weight: 1 },
    { id: "c", gcAmount: "0", scAmount: "1", weight: 6 },
  ];

  it("maps every roll in [0, total) to exactly the slice whose weight band contains it", () => {
    const got = Array.from({ length: 10 }, (_, roll) => drawSlice(slices, () => roll).id);
    expect(got).toEqual(["a", "a", "a", "b", "c", "c", "c", "c", "c", "c"]);
  });

  it("asks the random source for a roll over the TOTAL weight", () => {
    let asked = 0;
    drawSlice(slices, (max) => {
      asked = max;
      return 0;
    });
    expect(asked).toBe(10);
  });

  it("draws every configured slice with a real CSPRNG over many spins", () => {
    const offer = getDailyBonusOffer();
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(drawSlice(offer.slices).id);
    expect(seen.size).toBe(offer.slices.length);
  });
});

describe("streakLength", () => {
  it("counts consecutive days ending today when today is claimed", () => {
    expect(streakLength(["2026-09-21", "2026-09-22", "2026-09-23"], "2026-09-23")).toBe(3);
  });
  it("counts the run ending yesterday while today is still open", () => {
    expect(streakLength(["2026-09-21", "2026-09-22"], "2026-09-23")).toBe(2);
  });
  it("resets after a missed day", () => {
    expect(streakLength(["2026-09-19", "2026-09-20", "2026-09-22"], "2026-09-24")).toBe(0);
    expect(streakLength(["2026-09-19", "2026-09-20", "2026-09-22"], "2026-09-23")).toBe(1);
  });
});

describe("the configured offer", () => {
  it("is valid, and every slice is a win", () => {
    expect(() => validateDailyBonusOffer(getDailyBonusOffer())).not.toThrow();
  });
  it("refuses a slice that grants nothing, a float-ish amount, or a bad weight", () => {
    const base = getDailyBonusOffer();
    const bad = (slice: Partial<WheelSlice>) => () =>
      validateDailyBonusOffer({ ...base, slices: [{ id: "x", gcAmount: "1", scAmount: "0", weight: 1, ...slice }, base.slices[0]!] });
    expect(bad({ gcAmount: "0", scAmount: "0" })).toThrow(/grants nothing/);
    expect(bad({ gcAmount: "1e3" })).toThrow(/decimal strings/);
    expect(bad({ weight: 0 })).toThrow(/weight/);
    expect(bad({ weight: 1.5 })).toThrow(/weight/);
  });
});
