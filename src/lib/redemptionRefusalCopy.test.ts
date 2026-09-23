import { describe, expect, it } from "vitest";

import {
  isRedemptionRefusalCode,
  REDEMPTION_REFUSAL_CODES,
  REDEMPTION_REFUSAL_COPY,
} from "@/lib/redemptionRefusalCopy";

describe("redemptionRefusalCopy", () => {
  it.each(REDEMPTION_REFUSAL_CODES)("has non-empty copy for %s", (code) => {
    expect(REDEMPTION_REFUSAL_COPY[code].length).toBeGreaterThan(0);
  });

  it("gives every code distinct copy — no shared fallback string", () => {
    const messages = REDEMPTION_REFUSAL_CODES.map((code) => REDEMPTION_REFUSAL_COPY[code]);
    expect(new Set(messages).size).toBe(REDEMPTION_REFUSAL_CODES.length);
  });

  it("recognizes every declared code and rejects unknown ones", () => {
    for (const code of REDEMPTION_REFUSAL_CODES) {
      expect(isRedemptionRefusalCode(code)).toBe(true);
    }
    expect(isRedemptionRefusalCode("SOMETHING_ELSE")).toBe(false);
    expect(isRedemptionRefusalCode(null)).toBe(false);
  });
});
