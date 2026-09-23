import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/apiClient";
import { REDEMPTION_REFUSAL_CODES } from "@/lib/redemptionRefusalCopy";

import { classifyRedemptionError } from "./useRedemptionMutation";

describe("classifyRedemptionError", () => {
  it("classifies a 401 as unauthorized", () => {
    expect(classifyRedemptionError(new ApiError(401, "UNAUTHORIZED", "expired"))).toEqual({
      kind: "unauthorized",
    });
  });

  it.each(REDEMPTION_REFUSAL_CODES)("classifies %s as a refused outcome carrying the code", (code) => {
    const error = new ApiError(code === "KYC_NOT_VERIFIED" ? 403 : 422, code, "refused");
    expect(classifyRedemptionError(error)).toEqual({ kind: "refused", code, message: "refused" });
  });

  it.each(["ATTEMPT_OWNERSHIP", "ATTEMPT_SETTLED", "ATTEMPT_EXHAUSTED"])(
    "classifies a 409 %s as inFlight",
    (code) => {
      const error = new ApiError(409, code, "already working");
      expect(classifyRedemptionError(error)).toEqual({
        kind: "inFlight",
        errorCode: code,
        message: "already working",
      });
    },
  );

  it.each([500, 503, 408, 429, 0])("classifies a %d as unavailable", (status) => {
    const error = new ApiError(status, "ENGINE_UNAVAILABLE", "down");
    expect(classifyRedemptionError(error)).toEqual({
      kind: "unavailable",
      errorCode: "ENGINE_UNAVAILABLE",
      message: "down",
    });
  });

  it.each(["MALFORMED_RESPONSE", "MALFORMED_REDEMPTION_OVERVIEW"])(
    "classifies %s as unavailable regardless of status",
    (code) => {
      const error = new ApiError(200, code, "bad body");
      expect(classifyRedemptionError(error)).toEqual({
        kind: "unavailable",
        errorCode: code,
        message: "bad body",
      });
    },
  );

  it("classifies a non-refusal business 4xx as declined", () => {
    const error = new ApiError(404, "PLAYER_NOT_FOUND", "not provisioned");
    expect(classifyRedemptionError(error)).toEqual({
      kind: "declined",
      errorCode: "PLAYER_NOT_FOUND",
      message: "not provisioned",
    });
    const validation = new ApiError(422, "VALIDATION_ERROR", "bad amount");
    expect(classifyRedemptionError(validation)).toEqual({
      kind: "declined",
      errorCode: "VALIDATION_ERROR",
      message: "bad amount",
    });
  });

  it("treats a non-ApiError as unavailable — the safe default", () => {
    expect(classifyRedemptionError(new Error("boom"))).toEqual({
      kind: "unavailable",
      errorCode: null,
      message: "Unexpected client fault",
    });
  });
});
