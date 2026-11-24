import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RedeemWindow } from "@/components/RedeemWindow";
import { REDEMPTION_REFUSAL_CODES, REDEMPTION_REFUSAL_COPY } from "@/lib/redemptionRefusalCopy";
import { renderWithClient } from "@/test/renderWithClient";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function walletEnvelope(scRedeemable: string): unknown {
  return {
    success: true,
    data: {
      player_id: "pl_123",
      balances: { gc: "0.0000", sc_unplayed: "0.0000", sc_redeemable: scRedeemable },
    },
  };
}

const DEFAULT_POLICY = {
  jurisdictionPermitted: true,
  minimumAmount: "10.0000",
  maximumPerRequest: "500.0000",
  dailyCap: "1000.0000",
  monthlyCap: "5000.0000",
  remainingToday: "1000.0000",
  remainingThisMonth: "5000.0000",
};

function overviewEnvelope(opts: {
  kycStatus?: string;
  requests?: unknown[];
  policy?: unknown;
} = {}): unknown {
  return {
    success: true,
    data: {
      kycStatus: opts.kycStatus ?? "VERIFIED",
      requests: opts.requests ?? [],
      policy: opts.policy ?? DEFAULT_POLICY,
    },
  };
}

function redeemAcceptedEnvelope(amount: string): unknown {
  return {
    success: true,
    data: {
      status: "UNDER_REVIEW",
      redemptionId: "rdm_1",
      operatorTransactionId: "op_1",
      ledgerTransactionId: "lt_1",
      amount,
    },
  };
}

function refusalEnvelope(code: string, status: number): Response {
  return jsonResponse({ success: false, error: { code, message: "refused" } }, status);
}

/** Mirrors `refusalStatus()` (apps/financial-gateway/src/lib/redemption-policy.ts). */
const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  JURISDICTION_NOT_PERMITTED: 403,
  KYC_NOT_VERIFIED: 403,
  PLAYER_NOT_ACTIVE: 403,
  PLAYTHROUGH_OUTSTANDING: 403,
  BELOW_MINIMUM: 422,
  ABOVE_PER_REQUEST_CAP: 422,
  DAILY_CAP_EXCEEDED: 422,
  MONTHLY_CAP_EXCEEDED: 422,
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

interface RedeemRoute {
  walletReads: Array<() => Response>;
  overviewReads: Array<() => Response>;
  redeem?: () => Response;
}

/** URL-aware fetch router: wallet GETs and overview GETs in sequence; the redeem POST by path. */
function routeGateway(routes: RedeemRoute) {
  let walletCall = 0;
  let overviewCall = 0;
  fetchMock.mockImplementation((url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && path.endsWith("/wallet")) {
      const respond = routes.walletReads[walletCall] ?? routes.walletReads[routes.walletReads.length - 1];
      walletCall += 1;
      if (!respond) throw new Error("no wallet response routed");
      return Promise.resolve(respond());
    }
    if (method === "GET" && path.endsWith("/store/redemptions")) {
      const respond = routes.overviewReads[overviewCall] ?? routes.overviewReads[routes.overviewReads.length - 1];
      overviewCall += 1;
      if (!respond) throw new Error("no overview response routed");
      return Promise.resolve(respond());
    }
    if (method === "POST" && path.endsWith("/store/redeem")) {
      if (!routes.redeem) throw new Error("unexpected redeem POST");
      return Promise.resolve(routes.redeem());
    }
    throw new Error(`unrouted request: ${method} ${path}`);
  });
}

async function mountSynced(): Promise<void> {
  await screen.findByText("ledger-synced");
  await screen.findByText("Minimum");
}

function submitAmount(amount: string): void {
  fireEvent.change(screen.getByLabelText("Amount (SC)"), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Redeem" }));
}

describe("RedeemWindow — eligibility surface", () => {
  it("shows the redeemable balance as 'available to redeem', never total SC", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("250.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope())],
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    expect(screen.getByText("Available to redeem")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.queryByText(/total sc/i)).not.toBeInTheDocument();
  });

  it("shows the resolved caps and remaining amounts from the policy response", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("250.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope())],
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    expect(screen.getByText("10 SC")).toBeInTheDocument(); // minimum
    expect(screen.getByText("500 SC")).toBeInTheDocument(); // per-request cap
    expect(screen.getAllByText("1,000 SC").length).toBe(2); // daily cap + remaining today
    expect(screen.getAllByText("5,000 SC").length).toBe(2); // monthly cap + remaining this month
  });

  it("links to KYC and blocks the form when the player is not VERIFIED", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("250.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope({ kycStatus: "PENDING" }))],
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    expect(screen.getByText(REDEMPTION_REFUSAL_COPY.KYC_NOT_VERIFIED)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Verify now" })).toHaveAttribute("href", "/kyc");
    expect(screen.getByLabelText("Amount (SC)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redeem" })).toBeDisabled();
  });

  it("shows the jurisdiction refusal and blocks the form when redemption isn't permitted", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("250.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope({ policy: { jurisdictionPermitted: false } }))],
    });

    renderWithClient(<RedeemWindow />);
    await screen.findByText("ledger-synced");

    expect(await screen.findByText(REDEMPTION_REFUSAL_COPY.JURISDICTION_NOT_PERMITTED)).toBeInTheDocument();
    expect(screen.getByLabelText("Amount (SC)")).toBeDisabled();
  });

  it("lists request history newest first with a status badge", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("250.0000"))],
      overviewReads: [
        () =>
          jsonResponse(
            overviewEnvelope({
              requests: [
                {
                  id: "rdm_2",
                  amount: "75.0000",
                  status: "PAID",
                  createdAt: "2026-02-01T00:00:00.000Z",
                  statusChangedAt: "2026-02-02T00:00:00.000Z",
                },
                {
                  id: "rdm_1",
                  amount: "25.0000",
                  status: "REJECTED",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  statusChangedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
            }),
          ),
      ],
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    const items = screen.getAllByText(/^(75|25) SC$/);
    expect(items[0]).toHaveTextContent("75 SC");
    expect(items[1]).toHaveTextContent("25 SC");
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });
});

describe("RedeemWindow — submit flow", () => {
  it("a settled redemption invalidates the wallet, shows the accepted amount, and refetches history", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("1000.0000")), () => jsonResponse(walletEnvelope("950.0000"))],
      overviewReads: [
        () => jsonResponse(overviewEnvelope({ requests: [] })),
        () =>
          jsonResponse(
            overviewEnvelope({
              requests: [
                {
                  id: "rdm_1",
                  amount: "50.0000",
                  status: "UNDER_REVIEW",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  statusChangedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
            }),
          ),
      ],
      redeem: () => jsonResponse(redeemAcceptedEnvelope("50.0000")),
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    submitAmount("50");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Redemption of 50 SC submitted for review.",
      ),
    );
    expect(await screen.findByText("Under review")).toBeInTheDocument();

    const invalidations = info.mock.calls.filter(
      (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.invalidated",
    );
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.[1]).toMatchObject({ trigger: "redemption" });
  });

  it.each(REDEMPTION_REFUSAL_CODES)("shows distinct copy for the %s refusal and never touches the wallet again", async (code) => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("1000.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope())],
      redeem: () => refusalEnvelope(code, REFUSAL_STATUS[code] ?? 422),
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    submitAmount("50");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(REDEMPTION_REFUSAL_COPY[code]),
    );

    expect(fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? "GET") === "GET" && String(url).endsWith("/wallet"))).toHaveLength(1);
  });

  it("a 409 in-flight attempt tells the player their retry is safe", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("1000.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope())],
      redeem: () => refusalEnvelope("ATTEMPT_OWNERSHIP", 409),
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    submitAmount("50");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "A redemption attempt is already being processed. Your attempt is saved — retrying is safe and can never double-charge.",
      ),
    );
  });

  it("a validation error surfaces the gateway's own message", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("1000.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope())],
      redeem: () => jsonResponse({ success: false, error: { code: "VALIDATION_ERROR", message: "amount must be positive" } }, 422),
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    submitAmount("50");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Redemption failed: amount must be positive"),
    );
  });

  it("a 503 tells the player their attempt is saved and can be retried safely", async () => {
    routeGateway({
      walletReads: [() => jsonResponse(walletEnvelope("1000.0000"))],
      overviewReads: [() => jsonResponse(overviewEnvelope())],
      redeem: () => jsonResponse({ success: false, error: { code: "ENGINE_UNAVAILABLE", message: "down" } }, 503),
    });

    renderWithClient(<RedeemWindow />);
    await mountSynced();

    submitAmount("50");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Redemption failed: could not reach the cashier. Your attempt is saved — retrying is safe and can never double-charge.",
      ),
    );
    // G1/G4: an unavailable outcome must not fabricate or otherwise corrupt the wallet cache —
    // the resync path re-reads through the same choke point, it never guesses.
    expect(screen.getByText("1,000")).toBeInTheDocument();
  });
});
