import { describe, expect, it } from "vitest";

import { compactAmount } from "./compactAmount";

describe("compactAmount", () => {
  it.each([
    ["5000", "5K"],
    ["2500", "2.5K"],
    ["25000", "25K"],
    ["7500.0000", "7.5K"],
    ["1500000", "1.5M"],
    ["30000000", "30M"],
    ["999", "999"],
    ["0.2000", "0.2"],
    ["1.0000", "1"],
    ["0", "0"],
  ])("%s → %s", (input, expected) => {
    expect(compactAmount(input)).toBe(expected);
  });
});
