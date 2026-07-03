import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreWindow } from "@/components/StoreWindow";
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
      balances: { gc, sc_unplayed: "5.0000", sc_redeemable: "0" },
    },
  };
}

const purchaseIntentEnvelope = {
  success: true,
  data: {
    status: "requires_payment_confirmation",
    paymentIntentId: "pi_test_1",
    clientSecret: "cs_test_secret",
    operatorTransactionId: "op_tx_1",
  },
};

const mockConfirmEnvelope = { success: true, data: { status: "settled" } };

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

interface PurchaseRoute {
  purchase?: () => Response;
  confirm?: () => Response;
  walletReads: Array<() => Response>;
}

/** URL-aware fetch router: wallet GETs in sequence; purchase/confirm POSTs by path. */
function routeGateway(routes: PurchaseRoute) {
  let walletCall = 0;
  fetchMock.mockImplementation((url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && path.endsWith("/wallet")) {
      const respond = routes.walletReads[walletCall] ?? routes.walletReads[routes.walletReads.length - 1];
      walletCall += 1;
      if (!respond) throw new Error("no wallet response routed");
      return Promise.resolve(respond());
    }
    if (method === "POST" && path.endsWith("/store/purchase")) {
      if (!routes.purchase) throw new Error("unexpected purchase POST");
      return Promise.resolve(routes.purchase());
    }
    if (method === "POST" && path.endsWith("/store/purchase/mock-confirm")) {
      if (!routes.confirm) throw new Error("unexpected confirm POST");
      return Promise.resolve(routes.confirm());
    }
    throw new Error(`unrouted request: ${method} ${path}`);
  });
}

function walletGetCount(): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => (init?.method ?? "GET") === "GET" && String(url).endsWith("/wallet"),
  ).length;
}

/**
 * Wait for the hook's auto-hydration to settle. React Query batches observer notifications
 * through a macrotask, so tests must poll (findBy/waitFor) rather than flush microtasks.
 */
async function mountSynced(): Promise<void> {
  await screen.findByText("ledger-synced");
}

describe("StoreWindow — purchase flow (invalidate-after-action)", () => {
  it("a settled purchase invalidates the wallet and renders the ledger's new answer", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    routeGateway({
      purchase: () => jsonResponse(purchaseIntentEnvelope),
      confirm: () => jsonResponse(mockConfirmEnvelope),
      walletReads: [
        () => jsonResponse(walletEnvelope("1000.0000")),
        () => jsonResponse(walletEnvelope("6000.0000")),
      ],
    });

    renderWithClient(<StoreWindow />);
    await mountSynced();
    expect(screen.getByText("1,000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "BUY $5" }));

    // initiate → confirm → invalidate: exactly one extra wallet read, fresh strings rendered.
    await screen.findByText("6,000");
    expect(walletGetCount()).toBe(2);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Starter pack purchased — balances updated from the ledger.",
    );

    const invalidations = info.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.invalidated",
    );
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.[1]).toMatchObject({ trigger: "purchase" });
  });

  it("settled-but-re-read-failed keeps the honest stale warning (Gap 5's surface)", async () => {
    routeGateway({
      purchase: () => jsonResponse(purchaseIntentEnvelope),
      confirm: () => jsonResponse(mockConfirmEnvelope),
      walletReads: [
        () => jsonResponse(walletEnvelope("1000.0000")),
        () => jsonResponse({ success: false, error: { code: "ENGINE_UNAVAILABLE", message: "down" } }, 503),
      ],
    });

    renderWithClient(<StoreWindow />);
    await mountSynced();

    fireEvent.click(screen.getByRole("button", { name: "BUY $5" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Purchase settled, but the wallet re-read failed — balances may be stale.",
      ),
    );
    expect(screen.getByText("stale — last sync failed")).toBeInTheDocument();
    // The pre-purchase authoritative strings remain (stale-but-labeled, never fabricated).
    expect(screen.getByText("1,000")).toBeInTheDocument();
  });

  it("a declined purchase surfaces the gateway's message and never touches the wallet again", async () => {
    routeGateway({
      purchase: () => jsonResponse({ success: false, error: { code: "PAYMENT_DECLINED", message: "Card declined" } }, 402),
      walletReads: [() => jsonResponse(walletEnvelope("1000.0000"))],
    });

    renderWithClient(<StoreWindow />);
    await mountSynced();

    fireEvent.click(screen.getByRole("button", { name: "BUY $5" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Purchase failed: Card declined"),
    );
    expect(walletGetCount()).toBe(1); // no invalidation on a failed action — nothing to converge to
    expect(screen.getByText("1,000")).toBeInTheDocument();
  });

  it("a 401 on purchase asks the player to log in", async () => {
    routeGateway({
      purchase: () => jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "expired" } }, 401),
      walletReads: [() => jsonResponse(walletEnvelope("1000.0000"))],
    });

    renderWithClient(<StoreWindow />);
    await mountSynced();

    fireEvent.click(screen.getByRole("button", { name: "BUY $5" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Log in to make a purchase."),
    );
  });

  it("all BUY buttons are disabled while a purchase is in flight (single purchase at a time)", async () => {
    let releaseConfirm: (() => void) | undefined;
    // One router for the whole test: wallet GETs resolve, the confirm POST hangs until released.
    fetchMock.mockImplementation((url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/wallet")) {
        return Promise.resolve(jsonResponse(walletEnvelope("1000.0000")));
      }
      if (method === "POST" && path.endsWith("/store/purchase")) {
        return Promise.resolve(jsonResponse(purchaseIntentEnvelope));
      }
      if (method === "POST" && path.endsWith("/store/purchase/mock-confirm")) {
        return new Promise<Response>((resolve) => {
          releaseConfirm = () => resolve(jsonResponse(mockConfirmEnvelope));
        });
      }
      throw new Error(`unrouted request: ${method} ${path}`);
    });

    renderWithClient(<StoreWindow />);
    await mountSynced();

    fireEvent.click(screen.getByRole("button", { name: "BUY $5" }));

    await screen.findByRole("button", { name: "BUYING…" });
    expect(screen.getByRole("button", { name: "BUYING…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "BUY $20" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "BUY $50" })).toBeDisabled();

    await act(async () => {
      releaseConfirm?.();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "BUY $5" })).toBeEnabled());
  });
});
