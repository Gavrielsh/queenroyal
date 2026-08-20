import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  confirmMockStripeDeposit,
  fetchWalletBalances,
  initiateStorePurchase,
  isAbortError,
  isMoneyString,
  parseSpinEnvelope,
  parseWalletEnvelope,
} from "@/lib/apiClient";
import { getOrCreateAttemptToken, markSettled } from "@/lib/purchaseIntent";
import { walletBalancesQueryFn } from "@/lib/walletQueryFn";

/** Minimal BroadcastChannel double so the purchaseIntent module wires deterministically. */
class QuietBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) {}
  postMessage(): void {}
  close(): void {}
}

/** Build a real Response carrying a JSON body. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A 2xx Response double whose body read fails with `cause` (abort mid-body, truncation…). */
function bodyFailureResponse(cause: Error): Response {
  const double = {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.reject(cause),
  };
  return double as unknown as Response;
}

function abortException(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Canonical happy-path wallet envelope; per-field overrides for malformed-case tests. */
function walletEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    success: true,
    data: {
      player_id: "pl_123",
      balances: {
        gc: "1000.0000",
        sc_unplayed: "12.5",
        sc_redeemable: "0",
        ...overrides,
      },
    },
  };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", QuietBroadcastChannel);
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("fetchWalletBalances — happy path", () => {
  it("returns the engine strings verbatim, renamed to camelCase", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope()));

    const dto = await fetchWalletBalances();

    expect(dto).toEqual({ gc: "1000.0000", scUnplayed: "12.5", scRedeemable: "0" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/wallet$/);
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
  });

  it("accepts the wire format's boundary shapes (integer-only, 1–4 dp, huge magnitudes)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        walletEnvelope({
          gc: "999999999999999999.9999",
          sc_unplayed: "0.0001",
          sc_redeemable: "7",
        }),
      ),
    );

    await expect(fetchWalletBalances()).resolves.toEqual({
      gc: "999999999999999999.9999",
      scUnplayed: "0.0001",
      scRedeemable: "7",
    });
  });

  it("threads the caller's AbortSignal into fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope()));
    const controller = new AbortController();

    await fetchWalletBalances({ signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

describe("fetchWalletBalances — envelope validation (fail closed, cache stays clean)", () => {
  it.each([
    ["a JSON number (floats are forbidden for money)", 1000],
    ["a negative amount", "-5.0000"],
    ["more than 4 decimal places", "1.00001"],
    ["exponent notation", "1e3"],
    ["an empty string", ""],
    ["leading whitespace", " 12.34"],
    ["a dangling dot", "12."],
    ["a bare fraction", ".5"],
    ["a comma separator", "12,34"],
    ["null", null],
  ])("rejects gc as %s with MALFORMED_WALLET", async (_label, badValue) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope({ gc: badValue })));

    const failure = await fetchWalletBalances().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.code).toBe("MALFORMED_WALLET");
    expect(apiError.status).toBe(0);
    expect(isAbortError(apiError)).toBe(false);
    // Security: the message names the FIELD but never echoes the untrusted value.
    expect(apiError.message).toContain("data.balances.gc");
    if (typeof badValue === "string" && badValue.length > 0) {
      expect(apiError.message).not.toContain(badValue);
    }
  });

  it("rejects a missing balance field, naming it", async () => {
    const envelope = walletEnvelope() as { data: { balances: Record<string, unknown> } };
    delete envelope.data.balances.sc_redeemable;
    fetchMock.mockResolvedValueOnce(jsonResponse(envelope));

    await expect(fetchWalletBalances()).rejects.toMatchObject({
      code: "MALFORMED_WALLET",
      message: expect.stringContaining("data.balances.sc_redeemable") as string,
    });
  });

  it.each([
    ["success:false on a 2xx", { success: false, data: {} }, "success"],
    ["missing data", { success: true }, "data"],
    ["missing balances", { success: true, data: { player_id: "p" } }, "data.balances"],
    ["non-object root", null, "(root)"],
  ])("rejects %s", async (_label, payload, expectedField) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));

    await expect(fetchWalletBalances()).rejects.toMatchObject({
      code: "MALFORMED_WALLET",
      message: expect.stringContaining(expectedField) as string,
    });
  });
});

describe("abort classification", () => {
  it("classifies a pre-flight abort as ABORTED, not NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(abortException());
    const controller = new AbortController();
    controller.abort();

    const failure = await fetchWalletBalances({ signal: controller.signal }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("ABORTED");
    expect(isAbortError(failure)).toBe(true);
  });

  it("classifies an abort that fires mid-body (after headers) as ABORTED", async () => {
    fetchMock.mockResolvedValueOnce(bodyFailureResponse(abortException()));
    const controller = new AbortController();
    controller.abort();

    const failure = await fetchWalletBalances({ signal: controller.signal }).catch((e: unknown) => e);

    expect(isAbortError(failure)).toBe(true);
  });

  it("keeps a genuine transport fault as NETWORK_ERROR (isAbortError false)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const failure = await fetchWalletBalances().catch((e: unknown) => e);

    expect((failure as ApiError).code).toBe("NETWORK_ERROR");
    expect(isAbortError(failure)).toBe(false);
  });

  it("normalizes an unparseable 2xx body (no abort) as MALFORMED_RESPONSE", async () => {
    fetchMock.mockResolvedValueOnce(bodyFailureResponse(new SyntaxError("Unexpected end of JSON input")));

    const failure = await fetchWalletBalances().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("MALFORMED_RESPONSE");
  });
});

describe("gateway error envelope normalization", () => {
  it("parses the canonical nested envelope { success:false, error:{ code, message } }", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401),
    );

    const failure = await fetchWalletBalances().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe("UNAUTHORIZED");
    expect(apiError.message).toBe("Authentication required");
  });

  it("still accepts a legacy flat { code, message } body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "RATE_LIMITED", message: "Slow down" }, 429));

    await expect(fetchWalletBalances()).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      message: "Slow down",
    });
  });

  it("falls back to the status text for a non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );

    const failure = await fetchWalletBalances().catch((e: unknown) => e);

    const apiError = failure as ApiError;
    expect(apiError.status).toBe(502);
    expect(apiError.code).toBeUndefined();
    expect(apiError.message).toBe("Bad Gateway");
  });
});

describe("walletBalancesQueryFn", () => {
  it("threads React Query's context signal into the gateway fetch and resolves the DTO", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope()));
    const controller = new AbortController();

    const dto = await walletBalancesQueryFn({ signal: controller.signal });

    expect(dto.gc).toBe("1000.0000");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

describe("purchase boundary — server-anchored idempotency (brand + confirm guard)", () => {
  const intentEnvelope = {
    success: true,
    data: {
      status: "requires_payment_confirmation",
      paymentIntentId: "pi_brand_1",
      clientSecret: "cs_brand_1",
      operatorTransactionId: "op_brand_1",
    },
  };

  it("REJECTS a raw string/UUID at compile time — only a retained AttemptToken reaches the wire", () => {
    // The brand is the enforcement mechanism: this must not type-check.
    // @ts-expect-error — a raw string is not an AttemptToken
    const call = () => initiateStorePurchase("pkg_brand", crypto.randomUUID());
    expect(typeof call).toBe("function"); // never invoked; the assertion is the compile error
  });

  it("sends the retained token as idempotencyKey and binds it into the returned intent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(intentEnvelope));
    const token = getOrCreateAttemptToken("pkg_brand_wire");

    const intent = await initiateStorePurchase("pkg_brand_wire", token);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ packageId: "pkg_brand_wire", idempotencyKey: token });
    expect(intent).toEqual({
      paymentIntentId: "pi_brand_1",
      clientSecret: "cs_brand_1",
      packageId: "pkg_brand_wire",
      token,
    });
  });

  it("confirms a LIVE attempt over the wire", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(intentEnvelope));
    const token = getOrCreateAttemptToken("pkg_confirm_live");
    const intent = await initiateStorePurchase("pkg_confirm_live", token);

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { status: "settled" } }));
    const outcome = await confirmMockStripeDeposit(intent);

    expect(outcome).toEqual({ status: "settled" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // initiate + confirm
  });

  it("confirm-after-settle NO-OPS locally: the wire is never touched", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(intentEnvelope));
    const token = getOrCreateAttemptToken("pkg_confirm_settled");
    const intent = await initiateStorePurchase("pkg_confirm_settled", token);

    markSettled("pkg_confirm_settled"); // the attempt reached its terminal outcome elsewhere

    const outcome = await confirmMockStripeDeposit(intent);

    expect(outcome).toEqual({ status: "already_settled" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // initiate only — no confirm POST
  });

  it("confirm for a SUPERSEDED attempt (newer token minted) also no-ops", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(intentEnvelope));
    const staleToken = getOrCreateAttemptToken("pkg_confirm_superseded");
    const staleIntent = await initiateStorePurchase("pkg_confirm_superseded", staleToken);

    markSettled("pkg_confirm_superseded");
    getOrCreateAttemptToken("pkg_confirm_superseded"); // a NEW logical purchase begins

    const outcome = await confirmMockStripeDeposit(staleIntent);

    expect(outcome).toEqual({ status: "already_settled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("money-string validator (unit)", () => {
  it.each(["0", "7", "12.5", "0.0001", "1234.5000", "999999999999999999.9999"])(
    "accepts %s",
    (value) => {
      expect(isMoneyString(value)).toBe(true);
    },
  );

  it.each(["-1", "1.00001", "1e3", "", ".", "12.", ".5", "12,34", " 12", "NaN", "Infinity"])(
    "rejects %s",
    (value) => {
      expect(isMoneyString(value)).toBe(false);
    },
  );

  it("rejects non-string types outright (numbers can never be money)", () => {
    expect(isMoneyString(12.5)).toBe(false);
    expect(isMoneyString(null)).toBe(false);
    expect(isMoneyString(undefined)).toBe(false);
  });

  it("parseWalletEnvelope returns the validated DTO for a well-formed payload", () => {
    expect(parseWalletEnvelope(walletEnvelope())).toEqual({
      gc: "1000.0000",
      scUnplayed: "12.5",
      scRedeemable: "0",
    });
  });
});

describe("parseSpinEnvelope — the validation gate on a settled round", () => {
  /** A well-formed engine spin result; each test corrupts exactly one field. */
  function validSpin(): Record<string, unknown> {
    return {
      operator_transaction_id: "spin:attempt-1",
      player_id: "pl_1",
      bet_ledger_transaction_id: "ltx_bet_1",
      win_ledger_transaction_id: "ltx_win_1",
      family: "GC",
      bet_amount: "1.0000",
      win_amount: "20.0000",
      outcome: {
        game_id: "classic-3reel",
        paytable_version: "1.0.0",
        reels: ["BELL", "BELL", "BELL"],
        line: "THREE_OF_A_KIND",
        win_symbol: "BELL",
        multiplier: "20",
      },
      post_balances: { gc: "9999.0000", sc_unplayed: "0", sc_redeemable: "0" },
      status: "PROCESSED",
    };
  }

  function envelope(data: unknown): unknown {
    return { success: true, data };
  }

  it("accepts a well-formed round and camel-cases it without touching the money strings", () => {
    const parsed = parseSpinEnvelope(envelope(validSpin()));
    expect(parsed.betAmount).toBe("1.0000");
    expect(parsed.winAmount).toBe("20.0000");
    expect(parsed.postBalances).toEqual({ gc: "9999.0000", scUnplayed: "0", scRedeemable: "0" });
    expect(parsed.outcome.reels).toEqual(["BELL", "BELL", "BELL"]);
    expect(parsed.outcome.winSymbol).toBe("BELL");
    expect(parsed.status).toBe("PROCESSED");
  });

  it("normalizes an absent win leg on a losing round to null", () => {
    const losing: Record<string, unknown> = {
      ...validSpin(),
      win_amount: "0",
      win_ledger_transaction_id: undefined,
    };
    losing.outcome = {
      game_id: "classic-3reel",
      paytable_version: "1.0.0",
      reels: ["CHERRY", "LEMON", "BELL"],
      line: "NONE",
      multiplier: "0",
    };
    const parsed = parseSpinEnvelope(envelope(losing));
    expect(parsed.winLedgerTransactionId).toBeNull();
    expect(parsed.outcome.winSymbol).toBeNull();
    expect(parsed.outcome.line).toBe("NONE");
  });

  it.each([
    ["a float win amount", (s: Record<string, unknown>) => (s.win_amount = 20.0), "data.win_amount"],
    ["a 5-dp win amount", (s: Record<string, unknown>) => (s.win_amount = "20.00001"), "data.win_amount"],
    ["a negative bet", (s: Record<string, unknown>) => (s.bet_amount = "-1.0000"), "data.bet_amount"],
    ["a float balance", (s: Record<string, unknown>) => (s.post_balances = { gc: 1, sc_unplayed: "0", sc_redeemable: "0" }), "data.post_balances.gc"],
    ["an unknown family", (s: Record<string, unknown>) => (s.family = "BTC"), "data.family"],
    ["an unknown status", (s: Record<string, unknown>) => (s.status = "MAYBE"), "data.status"],
    ["a missing bet ledger id", (s: Record<string, unknown>) => (s.bet_ledger_transaction_id = ""), "data.bet_ledger_transaction_id"],
  ])("rejects %s", (_label, corrupt, field) => {
    const spin = validSpin();
    corrupt(spin);
    expect(() => parseSpinEnvelope(envelope(spin))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_SPIN", message: `Spin envelope failed validation at ${field}` }),
    );
  });

  it.each([
    ["empty reels", { reels: [] }, "data.outcome.reels"],
    ["a non-array reel set", { reels: "CROWN" }, "data.outcome.reels"],
    ["an absurd reel count", { reels: Array.from({ length: 11 }, () => "BELL") }, "data.outcome.reels"],
    ["a non-string reel", { reels: ["BELL", 7, "BELL"] }, "data.outcome.reels[1]"],
    ["an unknown line", { line: "FOUR_OF_A_KIND" }, "data.outcome.line"],
    ["a numeric multiplier", { multiplier: 20 }, "data.outcome.multiplier"],
    ["a missing paytable version", { paytable_version: "" }, "data.outcome.paytable_version"],
  ])("rejects %s", (_label, patch, field) => {
    const spin = validSpin();
    spin.outcome = { ...(spin.outcome as Record<string, unknown>), ...patch };
    expect(() => parseSpinEnvelope(envelope(spin))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_SPIN", message: `Spin envelope failed validation at ${field}` }),
    );
  });

  it("rejects a non-envelope, a failure envelope, and a missing data block", () => {
    for (const [payload, field] of [
      [null, "(root)"],
      ["nope", "(root)"],
      [{ success: false, error: { code: "X", message: "y" } }, "success"],
      [{ success: true }, "data"],
    ] as const) {
      expect(() => parseSpinEnvelope(payload)).toThrowError(
        expect.objectContaining({ message: `Spin envelope failed validation at ${field}` }),
      );
    }
  });

  it("never echoes the offending VALUE into the error message (untrusted payload hygiene)", () => {
    const spin = validSpin();
    spin.win_amount = "999999.99999-leaked-secret";
    try {
      parseSpinEnvelope(envelope(spin));
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as ApiError).message).toBe("Spin envelope failed validation at data.win_amount");
      expect((err as ApiError).message).not.toContain("leaked-secret");
    }
  });
});
