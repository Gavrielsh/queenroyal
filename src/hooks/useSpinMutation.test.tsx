import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifySpinError, useSpinMutation, SPIN_UNAVAILABLE_COOLDOWN_MS } from "@/hooks/useSpinMutation";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import { ApiError, type WalletBalancesDto } from "@/lib/apiClient";
import { makeQueryClient } from "@/lib/queryClient";
import { walletKeys } from "@/lib/queryKeys";
import { __resetSpinAttempts, peekSpinAttempt } from "@/lib/spinIntent";
import { disarmReconcile } from "@/lib/walletReconcile";

/**
 * Unit coverage for the spin mutation.
 *
 * The assertions that matter most here are not about the happy path — they are about which
 * failures ROTATE the idempotency token and which RETAIN it. Getting that backwards is the
 * difference between a lost round and a double-charged player, and it is invisible to any
 * test that only checks the returned copy.
 */

const GAME_ID = "classic-3reel";
const VARIABLES = { gameId: GAME_ID, currency: "GC" as const, betAmount: "1.0000" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function walletEnvelope(gc: string): unknown {
  return {
    success: true,
    data: { player_id: "pl_1", balances: { gc, sc_unplayed: "0", sc_redeemable: "0" } },
  };
}

function spinEnvelope(status = "PROCESSED"): unknown {
  return {
    success: true,
    data: {
      operator_transaction_id: "spin:attempt-1",
      player_id: "pl_1",
      bet_ledger_transaction_id: "ltx_bet_1",
      win_ledger_transaction_id: "ltx_win_1",
      family: "GC",
      bet_amount: "1.0000",
      win_amount: "20.0000",
      outcome: {
        game_id: GAME_ID,
        paytable_version: "1.0.0",
        reels: ["BELL", "BELL", "BELL"],
        line: "THREE_OF_A_KIND",
        win_symbol: "BELL",
        multiplier: "20",
      },
      post_balances: { gc: "9999.0000", sc_unplayed: "0", sc_redeemable: "0" },
      status,
    },
  };
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ success: false, error: { code, message } }, status);
}

const fetchMock = vi.fn<typeof fetch>();
let spinBodies: Array<Record<string, unknown>> = [];

function routeGateway(spinResponses: Array<() => Response | Promise<Response>>, walletGc = "1000.0000"): void {
  let spinCall = 0;
  fetchMock.mockImplementation((url, init) => {
    const method = init?.method ?? "GET";
    const path = String(url);
    if (method === "POST" && path.endsWith("/spin")) {
      spinBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const respond = spinResponses[spinCall] ?? spinResponses[spinResponses.length - 1];
      spinCall += 1;
      if (!respond) throw new Error("no spin response scripted");
      return Promise.resolve(respond());
    }
    if (method === "GET" && path.endsWith("/wallet")) {
      return Promise.resolve(jsonResponse(walletEnvelope(walletGc)));
    }
    throw new Error(`unrouted request: ${method} ${path}`);
  });
}

function walletReadCount(): number {
  return fetchMock.mock.calls.filter((call) => (call[1]?.method ?? "GET") === "GET").length;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  spinBodies = [];
  __resetSpinAttempts();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  disarmReconcile();
  __resetSpinAttempts();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Mount the spin hook alongside an ACTIVE wallet query on the same client — as in the app. */
function mountSpin() {
  const queryClient = makeQueryClient({ queries: { retry: false, gcTime: 0 } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  const view = renderHook(() => ({ spin: useSpinMutation(), wallet: useWalletQuery() }), { wrapper });
  return { ...view, queryClient };
}

describe("classifySpinError", () => {
  it.each([
    ["401 anything", new ApiError(401, "UNAUTHORIZED", "nope"), "unauthorized"],
    ["400 insufficient funds", new ApiError(400, "INSUFFICIENT_FUNDS", "insufficient funds"), "insufficientFunds"],
    ["409 pending", new ApiError(409, "TRANSACTION_PENDING", "in flight"), "inFlight"],
    ["409 key reuse", new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "reused"), "inFlight"],
    ["409 attempt ownership", new ApiError(409, "ATTEMPT_OWNERSHIP", "not yours"), "inFlight"],
    ["503 engine down", new ApiError(503, "ENGINE_UNAVAILABLE", "down"), "unavailable"],
    ["503 rng down", new ApiError(503, "RNG_UNAVAILABLE", "no entropy"), "unavailable"],
    ["502 bad gateway", new ApiError(502, "ENGINE_REJECTED", "bad"), "unavailable"],
    ["500 internal", new ApiError(500, "INTERNAL_ERROR", "boom"), "unavailable"],
    ["network fault", new ApiError(0, "NETWORK_ERROR", "unreachable"), "unavailable"],
    ["abort", new ApiError(0, "ABORTED", "aborted"), "unavailable"],
    ["429 throttled", new ApiError(429, "RATE_LIMITED", "slow down"), "unavailable"],
    ["408 timeout", new ApiError(408, "REQUEST_TIMEOUT", "timed out"), "unavailable"],
    ["unreadable 2xx body", new ApiError(0, "MALFORMED_SPIN", "bad shape"), "unavailable"],
    ["400 unknown game", new ApiError(400, "UNSUPPORTED_GAME", "unknown game"), "declined"],
    ["403 kyc gate", new ApiError(403, "KYC_REQUIRED", "verify first"), "declined"],
    ["403 geo block", new ApiError(403, "GEO_BLOCKED", "not here"), "declined"],
    ["422 validation", new ApiError(422, "VALIDATION_ERROR", "bad payload"), "declined"],
    ["404 no player", new ApiError(404, "PLAYER_NOT_FOUND", "who?"), "declined"],
    ["non-ApiError", new Error("kaboom"), "unavailable"],
  ])("classifies %s as %s", (_label, error, expected) => {
    expect(classifySpinError(error).kind).toBe(expected);
  });
});

describe("useSpinMutation — settlement", () => {
  it("returns the validated result, rotates the token, and re-reads the wallet", async () => {
    routeGateway([() => jsonResponse(spinEnvelope())]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));
    const readsBefore = walletReadCount();

    let outcome!: Awaited<ReturnType<typeof result.current.spin.spin>>;
    await act(async () => {
      outcome = await result.current.spin.spin(VARIABLES);
    });

    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") throw new Error("unreachable");
    expect(outcome.result.outcome.reels).toEqual(["BELL", "BELL", "BELL"]);
    expect(outcome.result.winAmount).toBe("20.0000");
    expect(outcome.walletSynced).toBe(true);
    // Terminal success rotates the anchor: the NEXT spin must be a new round.
    expect(peekSpinAttempt(GAME_ID)).toBeNull();
    expect(walletReadCount()).toBe(readsBefore + 1);
  });

  it("never writes the response's post_balances into the wallet cache (G1: one writer)", async () => {
    // The spin reports post_balances of 9999; the wallet endpoint reports 1000. If the cache
    // ever shows 9999, a mutation response became a second writer.
    routeGateway([() => jsonResponse(spinEnvelope())], "1000.0000");
    const { result, queryClient } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });

    const cached = queryClient.getQueryData<WalletBalancesDto>(walletKeys.balances());
    expect(cached?.gc).toBe("1000.0000");
    expect(cached?.gc).not.toBe("9999.0000");
  });

  it("mints a FRESH key for the next round after a settlement", async () => {
    routeGateway([() => jsonResponse(spinEnvelope())]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });
    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });

    expect(spinBodies).toHaveLength(2);
    expect(spinBodies[0]?.idempotencyKey).not.toBe(spinBodies[1]?.idempotencyKey);
  });
});

describe("useSpinMutation — token fate by failure kind", () => {
  it.each([
    ["insufficientFunds", () => errorResponse("INSUFFICIENT_FUNDS", "insufficient funds", 400), true],
    ["declined", () => errorResponse("UNSUPPORTED_GAME", "unknown game", 400), true],
    ["unavailable", () => errorResponse("ENGINE_UNAVAILABLE", "down", 503), false],
    ["inFlight", () => errorResponse("TRANSACTION_PENDING", "in flight", 409), false],
    ["unauthorized", () => errorResponse("UNAUTHORIZED", "expired", 401), false],
  ])("%s → token rotated: %s", async (_kind, respond, shouldRotate) => {
    routeGateway([respond]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });

    if (shouldRotate) {
      expect(peekSpinAttempt(GAME_ID)).toBeNull();
    } else {
      expect(peekSpinAttempt(GAME_ID)).not.toBeNull();
    }
  });

  it("a retryable failure makes the RETRY reuse the same key (ghost recovery, not a new draw)", async () => {
    routeGateway([
      () => errorResponse("ENGINE_UNAVAILABLE", "down", 503),
      () => jsonResponse(spinEnvelope("GHOST_RECOVERED")),
    ]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });
    // Clear the outage lockout so the retry is permitted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SPIN_UNAVAILABLE_COOLDOWN_MS + 50));
    });
    await waitFor(() => expect(result.current.spin.isCoolingDown).toBe(false));

    let retry!: Awaited<ReturnType<typeof result.current.spin.spin>>;
    await act(async () => {
      retry = await result.current.spin.spin(VARIABLES);
    });

    expect(spinBodies).toHaveLength(2);
    expect(spinBodies[0]?.idempotencyKey).toBe(spinBodies[1]?.idempotencyKey);
    expect(retry.status).toBe("settled");
    if (retry.status !== "settled") throw new Error("unreachable");
    expect(retry.result.status).toBe("GHOST_RECOVERED");
  }, 10_000);

  it("a declined wager rotates, so the next attempt is a genuinely new round", async () => {
    routeGateway([
      () => errorResponse("INSUFFICIENT_FUNDS", "insufficient funds", 400),
      () => jsonResponse(spinEnvelope()),
    ]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });
    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });

    expect(spinBodies[0]?.idempotencyKey).not.toBe(spinBodies[1]?.idempotencyKey);
  });
});

describe("useSpinMutation — re-read policy", () => {
  it.each([
    ["unavailable (the round may have committed)", () => errorResponse("ENGINE_UNAVAILABLE", "down", 503), true],
    ["inFlight (the round may have committed)", () => errorResponse("TRANSACTION_PENDING", "busy", 409), true],
    ["insufficientFunds (the rendered balance may be stale)", () => errorResponse("INSUFFICIENT_FUNDS", "no", 400), true],
    ["unauthorized (the read would fail identically)", () => errorResponse("UNAUTHORIZED", "expired", 401), false],
    ["declined (nothing moved)", () => errorResponse("UNSUPPORTED_GAME", "unknown", 400), false],
  ])("%s → wallet re-read: %s", async (_label, respond, shouldResync) => {
    routeGateway([respond]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));
    const readsBefore = walletReadCount();

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });

    expect(walletReadCount()).toBe(shouldResync ? readsBefore + 1 : readsBefore);
  });
});

describe("useSpinMutation — single flight and cooldown", () => {
  it("concurrent calls place exactly one wager; the loser is `blocked`", async () => {
    routeGateway([() => jsonResponse(spinEnvelope())]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));

    let outcomes!: Awaited<ReturnType<typeof result.current.spin.spin>>[];
    await act(async () => {
      outcomes = await Promise.all([
        result.current.spin.spin(VARIABLES),
        result.current.spin.spin(VARIABLES),
      ]);
    });

    expect(spinBodies).toHaveLength(1);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["blocked", "settled"]);
  });

  it("an outage arms a bounded cooldown that blocks wagers, then releases", async () => {
    vi.useFakeTimers();
    routeGateway([() => errorResponse("ENGINE_UNAVAILABLE", "down", 503)]);
    const { result } = mountSpin();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });
    expect(result.current.spin.isCoolingDown).toBe(true);
    expect(result.current.spin.isBlocked).toBe(true);

    // A wager attempted during the lockout never reaches the wire.
    const wagersDuringCooldown = spinBodies.length;
    let blocked!: Awaited<ReturnType<typeof result.current.spin.spin>>;
    await act(async () => {
      blocked = await result.current.spin.spin(VARIABLES);
    });
    expect(blocked.status).toBe("blocked");
    expect(spinBodies).toHaveLength(wagersDuringCooldown);

    // The lockout is bounded — the UI recovers without a reload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPIN_UNAVAILABLE_COOLDOWN_MS);
    });
    expect(result.current.spin.isCoolingDown).toBe(false);
    expect(result.current.spin.isBlocked).toBe(false);
  });

  it("a business decline does NOT arm a cooldown", async () => {
    routeGateway([() => errorResponse("INSUFFICIENT_FUNDS", "insufficient funds", 400)]);
    const { result } = mountSpin();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));

    await act(async () => {
      await result.current.spin.spin(VARIABLES);
    });

    expect(result.current.spin.isCoolingDown).toBe(false);
    expect(result.current.spin.isBlocked).toBe(false);
  });
});
