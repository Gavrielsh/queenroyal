import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyPurchaseError, usePurchaseMutation } from "@/hooks/usePurchaseMutation";
import { useWalletQuery } from "@/hooks/useWalletQuery";
import { ApiError } from "@/lib/apiClient";
import { markSettled, peekAttemptToken } from "@/lib/purchaseIntent";
import { makeQueryClient } from "@/lib/queryClient";

/** Deterministic BroadcastChannel double (the module wires to it on first use). */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posted: unknown[] = [];
  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    this.posted.push(data);
  }
  close(): void {}
}
vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

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

const intentEnvelope = {
  success: true,
  data: {
    status: "requires_payment_confirmation",
    paymentIntentId: "pi_1",
    clientSecret: "cs_1",
    operatorTransactionId: "op_1",
  },
};

const confirmEnvelope = { success: true, data: { status: "settled" } };

interface GatewayScript {
  /** Responses for successive POST /store/purchase calls (captured bodies exposed). */
  initiate: Array<() => Response>;
  confirm?: Array<() => Response>;
  wallet?: () => Response;
}

const fetchMock = vi.fn<typeof fetch>();
let initiateBodies: Array<Record<string, unknown>> = [];

function scriptGateway(script: GatewayScript): void {
  let initiateCall = 0;
  let confirmCall = 0;
  fetchMock.mockImplementation((url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && path.endsWith("/wallet")) {
      return Promise.resolve((script.wallet ?? (() => jsonResponse(walletEnvelope("100.0000"))))());
    }
    if (method === "POST" && path.endsWith("/store/purchase")) {
      initiateBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const respond = script.initiate[initiateCall] ?? script.initiate[script.initiate.length - 1];
      initiateCall += 1;
      if (!respond) throw new Error("no initiate response scripted");
      return Promise.resolve(respond());
    }
    if (method === "POST" && path.endsWith("/store/purchase/mock-confirm")) {
      const respond = (script.confirm ?? [() => jsonResponse(confirmEnvelope)])[confirmCall] ??
        (script.confirm ?? [() => jsonResponse(confirmEnvelope)]).at(-1);
      confirmCall += 1;
      if (!respond) throw new Error("no confirm response scripted");
      return Promise.resolve(respond());
    }
    throw new Error(`unrouted request: ${method} ${path}`);
  });
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  initiateBodies = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

/** Mount the purchase hook alongside an ACTIVE wallet query (same client) — as in the app. */
function mountPurchase() {
  const queryClient = makeQueryClient({ queries: { retry: false, gcTime: 0 } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return renderHook(
    () => ({ wallet: useWalletQuery(), mutation: usePurchaseMutation() }),
    { wrapper },
  );
}

function postedBroadcasts(): unknown[] {
  return FakeBroadcastChannel.instances.flatMap((instance) => instance.posted);
}

function walletInvalidations(): number {
  const info = vi.mocked(console.info);
  return info.mock.calls.filter(
    (call) => (call[1] as Record<string, unknown> | undefined)?.evt === "wallet.invalidated",
  ).length;
}

describe("classifyPurchaseError — exhaustive matrix", () => {
  it.each([
    [0, "NETWORK_ERROR", "retryable"],
    [0, "ABORTED", "retryable"],
    [408, "REQUEST_TIMEOUT", "retryable"],
    [429, "RATE_LIMITED", "retryable"],
    [500, "INTERNAL", "retryable"],
    [503, "ENGINE_UNAVAILABLE", "retryable"],
    [200, "MALFORMED_RESPONSE", "retryable"],
    [400, "VALIDATION", "declined"],
    [402, "PAYMENT_DECLINED", "declined"],
    [409, "CONFLICT", "declined"],
    [422, "UNPROCESSABLE", "declined"],
  ])("ApiError(status %i, %s) → %s", (status, code, expected) => {
    const failure = classifyPurchaseError(new ApiError(status, code, "msg"));
    expect(failure.kind).toBe(expected);
    if (failure.kind !== "unauthorized") {
      expect(failure.errorCode).toBe(code);
      expect(failure.message).toBe("msg");
    }
  });

  it("401 → unauthorized", () => {
    expect(classifyPurchaseError(new ApiError(401, "UNAUTHORIZED", "expired"))).toEqual({
      kind: "unauthorized",
    });
  });

  it("a non-ApiError is conservatively retryable (token retention is always safe)", () => {
    expect(classifyPurchaseError(new TypeError("boom"))).toEqual({
      kind: "retryable",
      errorCode: null,
      message: "Unexpected client fault",
    });
  });
});

describe("usePurchaseMutation — token lifecycle on the wire", () => {
  it("a settled purchase sends the token, rotates it, invalidates the wallet ONCE, and broadcasts in_flight→settled", async () => {
    scriptGateway({ initiate: [() => jsonResponse(intentEnvelope)] });
    const { result } = mountPurchase();
    const pkg = "pkg_m2t2_settle";

    const outcome = await result.current.mutation.purchase(pkg);

    expect(outcome).toEqual({ status: "settled", walletSynced: true });
    const sentToken = initiateBodies[0]?.idempotencyKey;
    expect(typeof sentToken).toBe("string");
    expect(peekAttemptToken(pkg)).toBeNull(); // rotated on settle
    expect(walletInvalidations()).toBe(1); // exactly-once through the shared choke point
    const states = postedBroadcasts()
      .filter((message): message is { packageId: string; state: string } =>
        typeof message === "object" && message !== null && (message as Record<string, unknown>).packageId === pkg,
      )
      .map((message) => message.state);
    expect(states).toEqual(["in_flight", "settled"]);
  });

  it("a 503 on initiate is retryable: the RETRY carries the IDENTICAL token; success then rotates it", async () => {
    scriptGateway({
      initiate: [
        () => jsonResponse({ success: false, error: { code: "ENGINE_UNAVAILABLE", message: "down" } }, 503),
        () => jsonResponse(intentEnvelope),
      ],
    });
    const { result } = mountPurchase();
    const pkg = "pkg_m2t2_retry";

    const first = await result.current.mutation.purchase(pkg);
    expect(first).toEqual({
      status: "failed",
      failure: { kind: "retryable", errorCode: "ENGINE_UNAVAILABLE", message: "down" },
    });
    expect(peekAttemptToken(pkg)).not.toBeNull(); // retained for the retry

    const second = await result.current.mutation.purchase(pkg);
    expect(second.status).toBe("settled");

    expect(initiateBodies).toHaveLength(2);
    expect(initiateBodies[1]?.idempotencyKey).toBe(initiateBodies[0]?.idempotencyKey);
  });

  it("a confirm-step failure AFTER the intent opened retries with the SAME token (no second intent identity)", async () => {
    scriptGateway({
      initiate: [() => jsonResponse(intentEnvelope), () => jsonResponse(intentEnvelope)],
      confirm: [
        () => jsonResponse({ success: false, error: { code: "PSP_TIMEOUT", message: "psp down" } }, 503),
        () => jsonResponse(confirmEnvelope),
      ],
    });
    const { result } = mountPurchase();
    const pkg = "pkg_m2t2_confirm_fault";

    const first = await result.current.mutation.purchase(pkg);
    expect(first.status).toBe("failed");
    expect(peekAttemptToken(pkg)).not.toBeNull();

    const second = await result.current.mutation.purchase(pkg);
    expect(second.status).toBe("settled");
    expect(initiateBodies[1]?.idempotencyKey).toBe(initiateBodies[0]?.idempotencyKey);
  });

  it("a business decline (402) abandons the attempt: token ROTATED, 'abandoned' broadcast, no invalidation", async () => {
    scriptGateway({
      initiate: [
        () => jsonResponse({ success: false, error: { code: "PAYMENT_DECLINED", message: "Card declined" } }, 402),
        () => jsonResponse(intentEnvelope),
      ],
    });
    const { result } = mountPurchase();
    const pkg = "pkg_m2t2_decline";

    const outcome = await result.current.mutation.purchase(pkg);

    expect(outcome).toEqual({
      status: "failed",
      failure: { kind: "declined", errorCode: "PAYMENT_DECLINED", message: "Card declined" },
    });
    expect(peekAttemptToken(pkg)).toBeNull(); // terminal → rotated
    expect(walletInvalidations()).toBe(0); // nothing settled, nothing to re-read
    expect(postedBroadcasts()).toContainEqual({ packageId: pkg, state: "abandoned" });

    // The NEXT attempt is a NEW logical purchase: a fresh token goes on the wire.
    await result.current.mutation.purchase(pkg);
    expect(initiateBodies[1]?.idempotencyKey).not.toBe(initiateBodies[0]?.idempotencyKey);
  });

  it("a 401 keeps the token (retry after login must dedupe) and reports unauthorized", async () => {
    scriptGateway({
      initiate: [
        () => jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "expired" } }, 401),
        () => jsonResponse(intentEnvelope),
      ],
    });
    const { result } = mountPurchase();
    const pkg = "pkg_m2t2_unauthorized";

    const outcome = await result.current.mutation.purchase(pkg);

    expect(outcome).toEqual({ status: "failed", failure: { kind: "unauthorized" } });
    expect(peekAttemptToken(pkg)).not.toBeNull();
    expect(postedBroadcasts()).toContainEqual({ packageId: pkg, state: "released" });

    await result.current.mutation.purchase(pkg);
    expect(initiateBodies[1]?.idempotencyKey).toBe(initiateBodies[0]?.idempotencyKey);
  });

  it("settled-but-re-read-failed: token still rotated (money IS settled), walletSynced false", async () => {
    let walletCalls = 0;
    scriptGateway({
      initiate: [() => jsonResponse(intentEnvelope)],
      wallet: () => {
        walletCalls += 1;
        // Mount read succeeds; the post-settle re-read fails.
        return walletCalls === 1
          ? jsonResponse(walletEnvelope("100.0000"))
          : jsonResponse({ success: false, error: { code: "ENGINE_UNAVAILABLE", message: "down" } }, 503);
      },
    });
    const { result } = mountPurchase();
    await waitFor(() => expect(result.current.wallet.phase).toBe("synced"));
    const pkg = "pkg_m2t2_reread_fail";

    const outcome = await result.current.mutation.purchase(pkg);

    expect(outcome).toEqual({ status: "settled", walletSynced: false });
    expect(peekAttemptToken(pkg)).toBeNull();
  });

  it("a peer settling MID-FLIGHT makes confirm a local no-op — the purchase still resolves settled", async () => {
    const pkg = "pkg_m2t3_peer_settle";
    scriptGateway({
      initiate: [
        () => {
          // The attempt settles elsewhere WHILE the initiate response is in flight — after
          // the mutation captured its token, before the confirm guard runs.
          markSettled(pkg);
          return jsonResponse(intentEnvelope);
        },
      ],
      confirm: [
        () => {
          throw new Error("confirm must never reach the wire when the attempt is already settled");
        },
      ],
    });
    const { result } = mountPurchase();

    const outcome = await result.current.mutation.purchase(pkg);

    expect(outcome.status).toBe("settled");
    const confirmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/store/purchase/mock-confirm"),
    );
    expect(confirmCalls).toHaveLength(0);
  });

  it("exposes isPending + pendingPackageId across the whole money window", async () => {
    let releaseConfirm: (() => void) | undefined;
    scriptGateway({
      initiate: [() => jsonResponse(intentEnvelope)],
      confirm: [() => jsonResponse(confirmEnvelope)],
    });
    fetchMock.mockImplementation((url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/wallet")) return Promise.resolve(jsonResponse(walletEnvelope("1.0000")));
      if (method === "POST" && path.endsWith("/store/purchase")) {
        initiateBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(jsonResponse(intentEnvelope));
      }
      return new Promise<Response>((resolve) => {
        releaseConfirm = () => resolve(jsonResponse(confirmEnvelope));
      });
    });
    const { result } = mountPurchase();
    const pkg = "pkg_m2t2_pending";

    const outcomePromise = result.current.mutation.purchase(pkg);
    await waitFor(() => expect(result.current.mutation.isPending).toBe(true));
    expect(result.current.mutation.pendingPackageId).toBe(pkg);

    releaseConfirm?.();
    await outcomePromise;
    await waitFor(() => expect(result.current.mutation.isPending).toBe(false));
    expect(result.current.mutation.pendingPackageId).toBeNull();
  });
});
