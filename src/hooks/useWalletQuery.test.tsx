import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockGameWindow } from "@/components/MockGameWindow";
import { StoreWindow } from "@/components/StoreWindow";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import { walletKeys } from "@/lib/queryKeys";
import { armReconcile, disarmReconcile, getReconcileState } from "@/lib/walletReconcile";
import { renderWithClient } from "@/test/renderWithClient";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function walletEnvelope(balances: Record<string, string> = {}): unknown {
  return {
    success: true,
    data: {
      player_id: "pl_123",
      balances: { gc: "1000.0000", sc_unplayed: "12.5", sc_redeemable: "0", ...balances },
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

/** Minimal consumer exposing the hook's view for assertions. */
function Probe({ label }: { label: string }) {
  const { balances, phase, errorStatus, lastSyncedAt } = useWalletQuery();
  return (
    <div>
      <span data-testid={`${label}-phase`}>{phase}</span>
      <span data-testid={`${label}-gc`}>{balances?.gc ?? "none"}</span>
      <span data-testid={`${label}-error-status`}>{errorStatus ?? "none"}</span>
      <span data-testid={`${label}-synced-at`}>{lastSyncedAt === null ? "never" : "set"}</span>
    </div>
  );
}

describe("useWalletQuery — single shared cache entry", () => {
  it("two consumers observe identical state from ONE fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope()));

    renderWithClient(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );

    await waitFor(() => expect(screen.getByTestId("a-phase")).toHaveTextContent("synced"));
    expect(screen.getByTestId("b-phase")).toHaveTextContent("synced");
    expect(screen.getByTestId("a-gc")).toHaveTextContent("1000.0000");
    expect(screen.getByTestId("b-gc")).toHaveTextContent("1000.0000");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts as an honest 'syncing' with null balances — never a fabricated zero", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope()));

    renderWithClient(<Probe label="a" />);

    expect(screen.getByTestId("a-phase")).toHaveTextContent("syncing");
    expect(screen.getByTestId("a-gc")).toHaveTextContent("none");
    expect(screen.getByTestId("a-synced-at")).toHaveTextContent("never");

    await waitFor(() => expect(screen.getByTestId("a-phase")).toHaveTextContent("synced"));
    expect(screen.getByTestId("a-synced-at")).toHaveTextContent("set");
  });
});

describe("useWalletQuery — error semantics", () => {
  it("maps a genuine query failure to phase 'error' with status + code surfaced", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401),
    );

    renderWithClient(<Probe label="a" />);

    await waitFor(() => expect(screen.getByTestId("a-phase")).toHaveTextContent("error"));
    expect(screen.getByTestId("a-error-status")).toHaveTextContent("401");
    expect(screen.getByTestId("a-gc")).toHaveTextContent("none");
  });

  it("emits wallet.query.error exactly ONCE per failure (cache choke point, no hook duplicate)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: "ENGINE_UNAVAILABLE", message: "down" } }, 503),
    );

    renderWithClient(<Probe label="a" />);
    await waitFor(() => expect(screen.getByTestId("a-phase")).toHaveTextContent("error"));

    const walletErrorEmissions = warn.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.query.error",
    );
    expect(walletErrorEmissions).toHaveLength(1);
    expect(walletErrorEmissions[0]?.[1]).toMatchObject({ code: "ENGINE_UNAVAILABLE", scope: "wallet" });
  });

  it("a successful read emits no telemetry from the hook", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope()));

    renderWithClient(<Probe label="a" />);
    await waitFor(() => expect(screen.getByTestId("a-phase")).toHaveTextContent("synced"));

    const allEmissions = [...warn.mock.calls, ...info.mock.calls].filter(
      (call) => typeof (call[1] as Record<string, unknown> | undefined)?.evt === "string",
    );
    expect(allEmissions).toHaveLength(0);
  });

  it("an aborted read never becomes phase 'error' and emits no error telemetry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A fetch that hangs until its signal aborts — mirroring the real transport boundary.
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortException()));
        }),
    );

    const { queryClient } = renderWithClient(<Probe label="a" />);
    expect(screen.getByTestId("a-phase")).toHaveTextContent("syncing");

    await act(async () => {
      await queryClient.cancelQueries({ queryKey: walletKeys.balances() });
    });

    await waitFor(() => expect(screen.getByTestId("a-phase")).not.toHaveTextContent("syncing"));
    expect(screen.getByTestId("a-phase")).toHaveTextContent("empty");
    const walletErrorEmissions = warn.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.query.error",
    );
    expect(walletErrorEmissions).toHaveLength(0);
  });
});

describe("reconcile integration — the wallet query as the polling engine", () => {
  it("SEAMLESS FALLBACK: disarmed, the query fetches once on mount and never polls", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(walletEnvelope())));

    renderWithClient(<Probe label="a" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("a-phase")).toHaveTextContent("synced");

    // A full minute passes with the controller idle: not one extra read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("armed with an unchanged ledger: polls on the backoff ladder, then exhausts at budget", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(walletEnvelope())));

    const { queryClient } = renderWithClient(<Probe label="a" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Arm around the CURRENT snapshot with a tight budget: 1s + 2s polls fit; then exhausted.
    act(() => {
      armReconcile(
        { gc: "1000.0000", scUnplayed: "12.5", scRedeemable: "0" },
        { trigger: "purchase", budgetMs: 3_500 },
      );
    });
    // Kick poll #1 (the M4-T2 contract: arm is followed by an invalidate; refetch stands in).
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: walletKeys.balances() });
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterKick = fetchMock.mock.calls.length;
    expect(afterKick).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // walks 1s, 2s → then deadline hits
    });

    expect(getReconcileState().phase).toBe("exhausted");
    const totalReads = fetchMock.mock.calls.length;
    expect(totalReads).toBeGreaterThan(afterKick); // it DID poll
    expect(totalReads).toBeLessThanOrEqual(afterKick + 3); // …on the ladder, not a hot loop

    // And once exhausted: silence again.
    const settled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(settled);
  });

  it("armed and the ledger answers with NEW strings: converges and stands down", async () => {
    vi.useFakeTimers();
    let credited = false;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(credited ? walletEnvelope({ gc: "6000.0000" }) : walletEnvelope()),
      ),
    );

    const { queryClient } = renderWithClient(<Probe label="a" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      armReconcile(
        { gc: "1000.0000", scUnplayed: "12.5", scRedeemable: "0" },
        { trigger: "purchase" },
      );
    });
    credited = true; // the webhook lands while we reconcile
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: walletKeys.balances() });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(getReconcileState().phase).toBe("idle"); // converged on poll #1
    expect(screen.getByTestId("a-gc")).toHaveTextContent("6000.0000");

    const settled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(settled); // no residual polling
  });
});

describe("component convergence — both windows, one cache entry", () => {
  it("MockGameWindow and StoreWindow render the same ledger strings from a single fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(walletEnvelope()));

    renderWithClient(
      <>
        <MockGameWindow />
        <StoreWindow />
      </>,
    );

    // Both status lines converge on the same phase…
    await waitFor(() => expect(screen.getAllByText("ledger-synced")).toHaveLength(2));
    // …and both GC chips render the identical verbatim-formatted string ("1000.0000" → "1,000").
    expect(screen.getAllByText("1,000")).toHaveLength(2);
    // SC Unplayed appears in both windows too.
    expect(screen.getAllByText("12.5")).toHaveLength(2);
    // The decisive assertion: two full windows, ONE network read.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders honest loading skeletons in both windows while the first read is in flight", () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));

    renderWithClient(
      <>
        <MockGameWindow />
        <StoreWindow />
      </>,
    );

    // 3 chips in the game window + 2 in the store window — all skeletons, never zeros.
    const skeletons = screen.getAllByTestId("balance-skeleton");
    expect(skeletons).toHaveLength(5);
    for (const skeleton of skeletons) expect(skeleton).toHaveRole("status");
    expect(screen.queryAllByTestId("balance-value")).toHaveLength(0);
    expect(screen.getAllByText("syncing…")).toHaveLength(2);
  });

  it("shows the login prompt in both windows when the read is unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401),
    );

    renderWithClient(
      <>
        <MockGameWindow />
        <StoreWindow />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText("log in to see your wallet")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
