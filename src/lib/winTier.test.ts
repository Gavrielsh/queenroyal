import { describe, expect, it } from "vitest";

import { winTierFor } from "./winTier";

describe("winTierFor", () => {
  it("maps high three-of-a-kinds to escalating tiers", () => {
    expect(winTierFor("THREE_OF_A_KIND", "BELL")).toBe("big");
    expect(winTierFor("THREE_OF_A_KIND", "DIAMOND")).toBe("mega");
    expect(winTierFor("THREE_OF_A_KIND", "SEVEN")).toBe("epic");
    expect(winTierFor("THREE_OF_A_KIND", "CROWN")).toBe("epic");
  });

  it("leaves low three-of-a-kinds, pairs and losses to the in-window notice", () => {
    expect(winTierFor("THREE_OF_A_KIND", "CHERRY")).toBeNull();
    expect(winTierFor("THREE_OF_A_KIND", "LEMON")).toBeNull();
    expect(winTierFor("TWO_OF_A_KIND", "CROWN")).toBeNull();
    expect(winTierFor("NONE", null)).toBeNull();
  });

  it("never celebrates a symbol it does not know (a new engine symbol stays quiet)", () => {
    expect(winTierFor("THREE_OF_A_KIND", "COMET")).toBeNull();
    expect(winTierFor("THREE_OF_A_KIND", null)).toBeNull();
  });
});
