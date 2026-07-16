import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockGameWindow } from "@/components/MockGameWindow";
import { disarmReconcile, getReconcileState } from "@/lib/walletReconcile";
import { renderWithClient } from "@/test/renderWithClient";

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

function abortException(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  disarmReconcile(); // the controller is module-level state — never leak an armed cell
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Route successive GET /wallet reads to the given responses, in order. */
function routeWalletReads(...responses: Array<() => Response | Promise<Response>>) {
  let call = 0;
  fetchMock.mockImplementation((_url, init) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error("unexpected non-GET in this test");
    const respond = responses[call] ?? responses[responses.length - 1];
    call += 1;
    if (!respond) throw new Error("no wallet response routed");
    return Promise.resolve(respond());
  });
}

/**
 * Settle the hook's auto-hydration under FAKE timers: React Query batches observer
 * notifications through a `setTimeout(0)` macrotask, so the notification timer must be
 * advanced explicitly — a bare microtask flush leaves the UI stuck on "syncing".
 */
async function mountSynced(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("ledger-synced")).toBeInTheDocument();
}

describe("MockGameWindow — spin flow (invalidate-after-action)", () => {
  it("spin invalidates the wallet, re-reads the ledger, and renders the fresh balance", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    routeWalletReads(
      () => jsonResponse(walletEnvelope("1000.0000")),
      () => jsonResponse(walletEnvelope("900.0000")),
    );

    renderWithClient(<MockGameWindow />);
    await mountSynced();
    expect(screen.getByText("1,000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /SPIN/ }));
    expect(screen.getByRole("button", { name: /SPINNING…/ })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900); // the settle window before the re-read
      await vi.advanceTimersByTimeAsync(0); // React Query's batched notification tick
    });

    // The shared cache entry was re-read once, and the ledger's new answer is rendered.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("900")).toBeInTheDocument();
    expect(screen.queryByText("1,000")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Wallet mirror synced with the ledger.");
    expect(screen.getByRole("button", { name: /SPIN \(settles provider-side\)/ })).toBeEnabled();

    // Success notices are transient: the confirmation dismisses itself.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Telemetry: exactly one wallet.invalidated, attributed to the spin.
    const invalidations = info.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.invalidated",
    );
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.[1]).toMatchObject({ evt: "wallet.invalidated", trigger: "spin" });

    // The ledger answered NEW strings on poll #1 → the reconciler converged and stood down.
    expect(getReconcileState().phase).toBe("idle");
  });

  it("a spin over an UNCHANGED ledger keeps reconciling on the ladder", async () => {
    vi.useFakeTimers();
    routeWalletReads(() => jsonResponse(walletEnvelope("1000.0000"))); // every read identical

    renderWithClient(<MockGameWindow />);
    await mountSynced();

    fireEvent.click(screen.getByRole("button", { name: /SPIN/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Poll #1 saw the same snapshot the spin started from → still converging.
    expect(getReconcileState()).toEqual({ phase: "reconciling", trigger: "spin" });
    const afterSpinReads = fetchMock.mock.calls.length;

    // The ladder's first delay elapses → one more poll fires through React Query.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock.mock.calls.length).toBe(afterSpinReads + 1);
    expect(getReconcileState().phase).toBe("reconciling");
  });

  it("a failed post-spin re-read toasts the stale warning (and keeps the old balance visible)", async () => {
    vi.useFakeTimers();
    routeWalletReads(
      () => jsonResponse(walletEnvelope("1000.0000")),
      () => jsonResponse({ success: false, error: { code: "ENGINE_UNAVAILABLE", message: "down" } }, 503),
    );

    renderWithClient(<MockGameWindow />);
    await mountSynced();

    fireEvent.click(screen.getByRole("button", { name: /SPIN/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not reach the cashier — balances may be stale.",
    );
    // Stale-but-labeled: the last authoritative strings stay rendered, flagged by the status line.
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(screen.getByText("stale — last sync failed")).toBeInTheDocument();

    // The spin armed BEFORE the failed re-read: the reconciler is the recovery path.
    expect(getReconcileState()).toEqual({ phase: "reconciling", trigger: "spin" });

    // Error notices PERSIST — a failed money action must never disappear on its own…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the cashier");
    // …until the player explicitly dismisses it.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a 401 on the post-spin re-read asks the player to log in", async () => {
    vi.useFakeTimers();
    routeWalletReads(
      () => jsonResponse(walletEnvelope("1000.0000")),
      () => jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "expired" } }, 401),
    );

    renderWithClient(<MockGameWindow />);
    await mountSynced();

    fireEvent.click(screen.getByRole("button", { name: /SPIN/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Log in to see your wallet.");
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

    // The signal threaded through queryFn → fetch (M1-T3) genuinely cancelled the request…
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
