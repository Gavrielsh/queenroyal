import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeQueryClient } from "@/lib/queryClient";

import { useDailyWheel } from "./useDailyWheel";

const fetchMock = vi.fn<typeof fetch>();
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const STATUS = {
  success: true,
  data: {
    segments: [
      { id: "s1", gc: "5000", sc: "0", weight: 1, featured: false },
      { id: "s2", gc: "0", sc: "0.2000", weight: 1, featured: false },
    ],
    streak: [{ day: 1, label: "Wheel", icon: "wheel", state: "today" }],
    streakDay: 1,
    canClaim: true,
    nextClaimAt: null,
  },
};
const GRANT = { success: true, data: { status: "GRANTED", segmentId: "s2", gcAmount: "0", scAmount: "0.2000" } };
const WALLET = { success: true, data: { player_id: "p", balances: { gc: "1", sc_unplayed: "1", sc_redeemable: "0" } } };

let claimBodies: Array<{ idempotencyKey: string }> = [];

function mount() {
  const queryClient = makeQueryClient({ queries: { retry: false, gcTime: 0 } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useDailyWheel(true), { wrapper });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  claimBodies = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

function route(claimResponses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  fetchMock.mockImplementation((url, init) => {
    const path = String(url);
    if (path.endsWith("/bonus/daily/claim")) {
      claimBodies.push(JSON.parse(String(init?.body)) as { idempotencyKey: string });
      const next = claimResponses[Math.min(i++, claimResponses.length - 1)]!;
      return Promise.resolve(next());
    }
    if (path.endsWith("/bonus/daily")) return Promise.resolve(json(STATUS));
    if (path.endsWith("/wallet")) return Promise.resolve(json(WALLET));
    throw new Error(`unrouted ${path}`);
  });
}

describe("useDailyWheel", () => {
  it("loads the live status and returns the server's grant", async () => {
    route([() => json(GRANT)]);
    const view = mount();
    await waitFor(() => expect(view.result.current.status?.canClaim).toBe(true));

    let grant;
    await act(async () => {
      grant = await view.result.current.claim();
    });
    expect(grant).toEqual({ segmentId: "s2", gc: "0", sc: "0.2000" });
  });

  it("RETAINS the attempt key after an ambiguous failure, so the retry replays the same attempt", async () => {
    route([() => json({ success: false, error: { code: "ENGINE_UNAVAILABLE", message: "down" } }, 502), () => json(GRANT)]);
    const view = mount();
    await waitFor(() => expect(view.result.current.status).toBeDefined());

    await act(async () => {
      await expect(view.result.current.claim()).rejects.toMatchObject({ ambiguous: true });
    });
    await act(async () => {
      await view.result.current.claim();
    });
    expect(claimBodies).toHaveLength(2);
    expect(claimBodies[1]!.idempotencyKey).toBe(claimBodies[0]!.idempotencyKey);
  });

  it("ROTATES the key after a terminal answer", async () => {
    route([() => json({ success: false, error: { code: "RATE_LIMITED", message: "slow" } }, 429), () => json(GRANT)]);
    const view = mount();
    await waitFor(() => expect(view.result.current.status).toBeDefined());

    await act(async () => {
      await expect(view.result.current.claim()).rejects.toMatchObject({ ambiguous: false });
    });
    await act(async () => {
      await view.result.current.claim();
    });
    expect(claimBodies[1]!.idempotencyKey).not.toBe(claimBodies[0]!.idempotencyKey);
  });
});
