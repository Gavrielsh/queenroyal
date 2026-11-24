import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/apiClient";

import { parseDailyBonusClaim, parseDailyBonusStatus, toWheelClaimError } from "./dailyBonusClient";

const status = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    segments: [
      { id: "s1", gc: "5000", sc: "0", weight: 18, featured: false },
      { id: "s2", gc: "0", sc: "0.2000", weight: 14, featured: false },
    ],
    totalWeight: 32,
    streak: [{ day: 1, label: "Wheel", icon: "wheel", state: "today" }],
    streakDay: 1,
    canClaim: true,
    nextClaimAt: null,
    gamingDate: "2026-09-23",
    timeZone: "America/New_York",
    ...over,
  },
});

describe("parseDailyBonusStatus", () => {
  it("keeps money as the gateway's strings and carries the published weights", () => {
    const parsed = parseDailyBonusStatus(status());
    expect(parsed.segments[1]).toEqual({ id: "s2", gc: "0", sc: "0.2000", featured: false, weight: 14 });
    expect(parsed.canClaim).toBe(true);
  });

  it.each([
    ["a numeric amount", { segments: [{ id: "s1", gc: 5000, sc: "0" }, { id: "s2", gc: "1", sc: "0" }] }],
    ["an exponent amount", { segments: [{ id: "s1", gc: "5e3", sc: "0" }, { id: "s2", gc: "1", sc: "0" }] }],
    ["an unknown streak state", { streak: [{ day: 1, label: "Wheel", icon: "wheel", state: "maybe" }] }],
    ["a missing canClaim", { canClaim: undefined }],
  ])("refuses %s", (_label, over) => {
    expect(() => parseDailyBonusStatus(status(over))).toThrow(ApiError);
  });
});

describe("parseDailyBonusClaim", () => {
  it("maps the grant to the wheel's shape, amounts verbatim", () => {
    const claim = parseDailyBonusClaim({
      success: true,
      data: { status: "GRANTED", segmentId: "s6", gcAmount: "25000", scAmount: "1.0000", claimId: "c1" },
    });
    expect(claim).toEqual({ segmentId: "s6", gc: "25000", sc: "1.0000" });
  });

  it("refuses anything that is not a grant", () => {
    expect(() => parseDailyBonusClaim({ success: true, data: { status: "PENDING", segmentId: "s1", gcAmount: "1", scAmount: "0" } })).toThrow(ApiError);
  });
});

describe("toWheelClaimError", () => {
  it("is honest when the outcome is unknown, and marks it ambiguous so the key is retained", () => {
    for (const err of [new ApiError(0, "NETWORK_ERROR", "x"), new ApiError(502, "ENGINE_UNAVAILABLE", "x"), new ApiError(409, "ATTEMPT_IN_FLIGHT", "x")]) {
      const mapped = toWheelClaimError(err);
      expect(mapped.ambiguous).toBe(true);
      expect(mapped.message).toMatch(/If it went through/);
      expect(mapped.message).not.toMatch(/Nothing was/);
    }
  });

  it("is terminal (not ambiguous) for a spent day or a blocked account", () => {
    expect(toWheelClaimError(new ApiError(409, "ALREADY_CLAIMED_TODAY", "x"))).toMatchObject({ ambiguous: false, message: expect.stringMatching(/come back tomorrow/) });
    expect(toWheelClaimError(new ApiError(403, "PLAYER_NOT_ACTIVE", "x")).ambiguous).toBe(false);
  });
});
