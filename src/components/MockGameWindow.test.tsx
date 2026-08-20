import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockGameWindow } from "@/components/MockGameWindow";
import { __resetSpinAttempts, peekSpinAttempt } from "@/lib/spinIntent";
import { disarmReconcile, getReconcileState } from "@/lib/walletReconcile";
import { renderWithClient } from "@/test/renderWithClient";

/**
 * Component-level coverage for the SERVER-AUTHORITATIVE spin loop.
 *
 * The contract under test, in one line: the only symbols the player ever sees settled are the
 * ones the ledger recorded. Every failure path therefore asserts BOTH the copy and the reels —
 * a window that renders a fabricated outcome after a failed wager is the exact bug this
 * component exists to make impossible.
 */

const GAME_ID = "classic-3reel";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function walletEnvelope(gc: string): unknown {
  return {
    success: true,
    data: {
      player_id: "pl_123",
      balances: { gc, sc_unplayed: "12.5", sc_redeemable: "0" },
    },
  };
}

interface SpinOverrides {
  reels?: string[];
  line?: string;
  winSymbol?: string | null;
  winAmount?: string;
  multiplier?: string;
  status?: string;
}

/** Mirrors apps/financial-gateway/src/routes/spin.ts → `okBody(EngineSpinResult)`. */
function spinEnvelope(over: SpinOverrides = {}): unknown {
  const line = over.line ?? "THREE_OF_A_KIND";
  return {
    success: true,
    data: {
      operator_transaction_id: "spin:attempt-1",
      player_id: "pl_123",
      bet_ledger_transaction_id: "ltx_bet_1",
      win_ledger_transaction_id: line === "NONE" ? undefined : "ltx_win_1",
      family: "GC",
      bet_amount: "1.0000",
      win_amount: over.winAmount ?? (line === "NONE" ? "0" : "400.0000"),
      outcome: {
        game_id: GAME_ID,
        paytable_version: "1.0.0",
        reels: over.reels ?? ["CROWN", "CROWN", "CROWN"],
        line,
        win_symbol: over.winSymbol === undefined ? (line === "NONE" ? undefined : "CROWN") : over.winSymbol,
        multiplier: over.multiplier ?? (line === "NONE" ? "0" : "400"),
      },
      post_balances: { gc: "1399.0000", sc_unplayed: "12.5", sc_redeemable: "0" },
      status: over.status ?? "PROCESSED",
    },
  };
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ success: false, error: { code, message } }, status);
}

function abortException(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

const fetchMock = vi.fn<typeof fetch>();

/** The symbols currently rendered on the reels, read straight from the DOM. */
function renderedReels(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="reel"]')).map(
    (el) => el.getAttribute("data-symbol") ?? "",
  );
}

/** POST bodies captured for `/api/spin`, so idempotency can be asserted on the wire. */
let spinBodies: Array<Record<string, unknown>> = [];

/**
 * Route `GET /wallet` reads and `POST /spin` wagers independently, each advancing through its
 * own scripted list (the last entry repeats).
 */
function routeGateway(script: {
  wallet: Array<() => Response | Promise<Response>>;
  spin?: Array<() => Response | Promise<Response>>;
}): void {
  let walletCall = 0;
  let spinCall = 0;
  fetchMock.mockImplementation((_url, init) => {
    const method = init?.method ?? "GET";
    const path = String(_url);

    if (method === "POST" && path.endsWith("/spin")) {
      spinBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const list = script.spin ?? [];
      const respond = list[spinCall] ?? list[list.length - 1];
      spinCall += 1;
      if (!respond) throw new Error("no spin response scripted");
      return Promise.resolve(respond());
    }

    if (method === "GET" && path.endsWith("/wallet")) {
      const respond = script.wallet[walletCall] ?? script.wallet[script.wallet.length - 1];
      walletCall += 1;
      if (!respond) throw new Error("no wallet response scripted");
      return Promise.resolve(respond());
    }

    throw new Error(`unrouted request: ${method} ${path}`);
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  spinBodies = [];
  __resetSpinAttempts();
});

afterEach(() => {
  disarmReconcile(); // module-level controller — never leak an armed cell between tests
  __resetSpinAttempts(); // module-level token map — never leak an idempotency key
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Settle the wallet hook's auto-hydration under FAKE timers: React Query batches observer
 * notifications through a `setTimeout(0)` macrotask, so the notification timer must be
 * advanced explicitly — a bare microtask flush leaves the UI stuck on "syncing".
 */
async function mountSynced(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("ledger-synced")).toBeInTheDocument();
}

/** Click SPIN and let the request, the settle, and the re-read all flush. */
async function clickSpinAndSettle(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /SPIN/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("MockGameWindow — the settled round", () => {
  it("renders the ENGINE's reels and the verbatim win amount, then re-reads the ledger", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000")), () => jsonResponse(walletEnvelope("1399.0000"))],
      spin: [() => jsonResponse(spinEnvelope())],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    expect(screen.getByText("1,000")).toBeInTheDocument();

    await clickSpinAndSettle();

    // The symbols on screen are the engine's, not a local draw.
    expect(renderedReels()).toEqual(["CROWN", "CROWN", "CROWN"]);
    // The win figure is the engine's decimal string, interpolated verbatim (no re-formatting).
    expect(screen.getByRole("alert")).toHaveTextContent("you won 400.0000 GC");
    // The balance came from the RE-READ, never from the spin response's post_balances.
    expect(screen.getByText("1,399")).toBeInTheDocument();

    // Exactly one invalidation, attributed to the spin.
    const invalidations = info.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.invalidated",
    );
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.[1]).toMatchObject({ evt: "wallet.invalidated", trigger: "spin" });
  });

  it("renders a losing line without inventing a payout", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000")), () => jsonResponse(walletEnvelope("999.0000"))],
      spin: [() => jsonResponse(spinEnvelope({ reels: ["CHERRY", "LEMON", "BELL"], line: "NONE" }))],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    await clickSpinAndSettle();

    expect(renderedReels()).toEqual(["CHERRY", "LEMON", "BELL"]);
    expect(screen.getByRole("alert")).toHaveTextContent("No win this round. 1.0000 GC staked.");
    expect(screen.getByText("999")).toBeInTheDocument();
  });

  it("does NOT arm the reconciler — a spin settles synchronously at the ledger", async () => {
    vi.useFakeTimers();
    // Every wallet read returns the SAME snapshot. Under the purchase flow's
    // reconcile-until-changed this would poll the whole ladder; a spin must stand still.
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000"))],
      spin: [() => jsonResponse(spinEnvelope())],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    await clickSpinAndSettle();

    expect(getReconcileState().phase).toBe("idle");
    const readsAfterSpin = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock.mock.calls.length).toBe(readsAfterSpin); // no polling ladder
  });

  it("surfaces a GHOST_RECOVERED replay honestly instead of passing it off as a fresh round", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000")), () => jsonResponse(walletEnvelope("1399.0000"))],
      spin: [() => jsonResponse(spinEnvelope({ status: "GHOST_RECOVERED" }))],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    await clickSpinAndSettle();

    expect(renderedReels()).toEqual(["CROWN", "CROWN", "CROWN"]);
    expect(screen.getByRole("alert")).toHaveTextContent("you were not charged twice");
    expect(screen.getByRole("button", { name: /SPIN ·/ })).toBeEnabled();
  });
});

describe("MockGameWindow — edge cases", () => {
  it("INSUFFICIENT_FUNDS: warns, leaves the reels untouched, and re-enables the button", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("0.5000"))],
      spin: [() => errorResponse("INSUFFICIENT_FUNDS", "insufficient funds", 400)],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    const before = renderedReels();

    await clickSpinAndSettle();

    expect(screen.getByRole("alert")).toHaveTextContent("Not enough GC for a 1.0000 stake");
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was charged.");
    // No fabricated outcome survived the failure.
    expect(renderedReels()).toEqual(before);
    // A declined wager wrote nothing, so the spent anchor is rotated away.
    expect(peekSpinAttempt(GAME_ID)).toBeNull();
    expect(screen.getByRole("button", { name: /SPIN ·/ })).toBeEnabled();
  });

  it("503: shows the outage copy, DISABLES spin for the cooldown, then recovers", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000"))],
      spin: [() => errorResponse("ENGINE_UNAVAILABLE", "the ledger is temporarily unavailable", 503)],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    const before = renderedReels();

    await clickSpinAndSettle();

    expect(screen.getByRole("alert")).toHaveTextContent("Service temporarily unavailable");
    expect(renderedReels()).toEqual(before);
    // The token is RETAINED: the round's fate is unknown, so a retry must ghost-recover it.
    expect(peekSpinAttempt(GAME_ID)).not.toBeNull();

    const button = screen.getByRole("button", { name: /UNAVAILABLE/ });
    expect(button).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole("button", { name: /SPIN ·/ })).toBeEnabled();
  });

  it("a network timeout is treated exactly like a 503 (the round's fate is unknown)", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000"))],
      spin: [() => Promise.reject(new TypeError("Failed to fetch"))],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    await clickSpinAndSettle();

    expect(screen.getByRole("alert")).toHaveTextContent("Service temporarily unavailable");
    expect(peekSpinAttempt(GAME_ID)).not.toBeNull(); // retained for the ghost-recovering retry
    expect(screen.getByRole("button", { name: /UNAVAILABLE/ })).toBeDisabled();
  });

  it("409: reports the round as still settling, without a cooldown", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000"))],
      spin: [() => errorResponse("TRANSACTION_PENDING", "transaction already in flight", 409)],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    await clickSpinAndSettle();

    expect(screen.getByRole("alert")).toHaveTextContent("still settling");
    expect(peekSpinAttempt(GAME_ID)).not.toBeNull(); // same attempt — never a new wager
    // A 409 is not an outage: the affordance stays live so the player can retry the SAME round.
    expect(screen.getByRole("button", { name: /SPIN ·/ })).toBeEnabled();
  });

  it("401: asks the player to log in and keeps the token for the post-login retry", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000"))],
      spin: [() => errorResponse("UNAUTHORIZED", "Authentication required", 401)],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    await clickSpinAndSettle();

    expect(screen.getByRole("alert")).toHaveTextContent("Log in to spin.");
    expect(peekSpinAttempt(GAME_ID)).not.toBeNull();
  });

  it("a double-click places exactly ONE wager", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000")), () => jsonResponse(walletEnvelope("1399.0000"))],
      spin: [() => jsonResponse(spinEnvelope())],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();

    const button = screen.getByRole("button", { name: /SPIN/ });
    // Both clicks dispatched inside the same tick, before any re-render can disable the button.
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(spinBodies).toHaveLength(1);
  });

  it("sends only a stake, a currency, a game and an idempotency key — never an outcome", async () => {
    vi.useFakeTimers();
    routeGateway({
      wallet: [() => jsonResponse(walletEnvelope("1000.0000")), () => jsonResponse(walletEnvelope("1399.0000"))],
      spin: [() => jsonResponse(spinEnvelope())],
    });

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    await clickSpinAndSettle();

    const body = spinBodies[0];
    expect(Object.keys(body ?? {}).sort()).toEqual(["betAmount", "currency", "gameId", "idempotencyKey"]);
    expect(body).toMatchObject({ betAmount: "1.0000", currency: "GC", gameId: GAME_ID });
    // The gateway's schema requires 8–200 chars for the anchor.
    expect(String(body?.idempotencyKey).length).toBeGreaterThanOrEqual(8);
  });
});

describe("MockGameWindow — unmount aborts the in-flight read", () => {
  it("unmounting mid-fetch aborts the HTTP request and emits no error telemetry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          capturedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(abortException()));
        }),
    );

    const { unmount } = renderWithClient(<MockGameWindow />);
    expect(screen.getByText("syncing…")).toBeInTheDocument();
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    await act(async () => {}); // let the cancellation settle

    // The signal threaded through queryFn → fetch genuinely cancelled the request…
    expect(capturedSignal?.aborted).toBe(true);
    // …and a cancellation is not an error: no wallet.query.error reached telemetry.
    const errorEmissions = warn.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.query.error",
    );
    expect(errorEmissions).toHaveLength(0);
  });

  it("render() without a provider is the only unsupported mount (sanity: provider required)", () => {
    // Guards against accidentally moving the hook out of the provider tree: mounting outside
    // a QueryClientProvider must throw React Query's descriptive error, not render garbage.
    vi.spyOn(console, "error").mockImplementation(() => {}); // silence React's boundary noise
    expect(() => render(<MockGameWindow />)).toThrowError(/QueryClient/);
  });
});
