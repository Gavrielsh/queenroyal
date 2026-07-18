import { act, cleanup, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWalletQuery } from "@/hooks/useWalletQuery";
import {
  REALTIME_INVALIDATE_DEBOUNCE_MS,
  useWalletChannel,
} from "@/lib/realtime/useWalletChannel";
import { walletKeys } from "@/lib/queryKeys";
import { disarmReconcile } from "@/lib/walletReconcile";
import { renderWithClient } from "@/test/renderWithClient";

/**
 * Push-to-invalidate integration suite (M4-T5). Deliberately uses STATIC imports: the
 * channel singleton and the lifecycle ref-count are module-level state shared across these
 * tests — exactly like a browser session. Hygiene contract: every test ends with cleanup()
 * + runAllTimers() (in afterEach) so the deferred close completes and the next test's mount
 * re-opens the same singleton from a genuinely closed state.
 */

/** Deterministic EventSource double: named-event emission, close tracking, instance log. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }

  emitNamed(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const CHANNEL_URL = "http://localhost:4000/api/wallet/stream";

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

const fetchMock = vi.fn<typeof fetch>();

/** The production wiring in miniature: the bridge renders nothing, a sibling reads. */
function Bridge() {
  useWalletChannel();
  return null;
}

function Probe() {
  const { balances } = useWalletQuery();
  return <span data-testid="gc">{balances?.gc ?? "none"}</span>;
}

function source(): FakeEventSource {
  const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!last) throw new Error("no EventSource constructed");
  return last;
}

/** Advance fake time, then drain the React Query notify macrotasks (setTimeout(0)). */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Every `wallet.invalidated { trigger: "realtime" }` emission — THE coalescing meter. */
function realtimeInvalidations(): Record<string, unknown>[] {
  return [...vi.mocked(console.info).mock.calls]
    .map((call) => call[1] as Record<string, unknown> | undefined)
    .filter(
      (record): record is Record<string, unknown> =>
        record?.evt === "wallet.invalidated" && record?.trigger === "realtime",
    );
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(walletEnvelope())));
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  // Unmount FIRST (under fake timers), then run the deferred one-tick close to completion so
  // the shared channel singleton is genuinely closed before the next test connects it again.
  cleanup();
  act(() => {
    vi.runAllTimers();
  });
  disarmReconcile();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("feature-flag fallback", () => {
  it("FLAG UNSET: the bridge is fully inert — no stream, no realtime invalidations, Phase A untouched", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", "");

    renderWithClient(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    await settle();
    expect(screen.getByTestId("gc")).toHaveTextContent("1000.0000");

    await settle(60_000); // a full minute: nothing connects, nothing invalidates
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(realtimeInvalidations()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the mount read and nothing else
  });
});

describe("catch-up fetching", () => {
  it("INITIAL CONNECT: reaching healthy triggers ONE debounced 'realtime' invalidation, and the money arrives via the validated fetch — never the stream", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);
    let gc = "1000.0000";
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(walletEnvelope({ gc }))));

    const { queryClient, rerender } = renderWithClient(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    await settle();
    expect(screen.getByTestId("gc")).toHaveTextContent("1000.0000");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The ledger moves while we were blind — the stream itself never carries the number.
    gc = "6000.0000";
    source().emitOpen();
    expect(realtimeInvalidations()).toHaveLength(0); // debounced, not instant

    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one catch-up read

    // The validated fetch path — and nothing else — wrote the new string into the cache…
    expect(queryClient.getQueryData(walletKeys.balances())).toMatchObject({ gc: "6000.0000" });
    // …and a re-read renders it. (The observer notify→render hop drops under fake timers —
    // M4-T2 precedent; live render delivery is covered by the component and e2e suites.)
    rerender(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    expect(screen.getByTestId("gc")).toHaveTextContent("6000.0000");
  });

  it("RECONNECT: drop → backoff reopen → healthy again re-reads the ledger (the blind window is recovered)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);

    renderWithClient(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    await settle();
    const first = source();
    first.emitOpen();
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(1); // initial catch-up

    first.emitError(); // transport dies mid-session
    expect(first.closed).toBe(true); // M4-T4 close-on-error: we own reconnect timing

    await settle(1_000); // equal-jitter attempt-1 delay is 500–1000ms — this covers it
    const second = source();
    expect(second).not.toBe(first);

    second.emitOpen(); // back to healthy
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(2); // one catch-up per arrival at healthy
    expect(fetchMock).toHaveBeenCalledTimes(1 + realtimeInvalidations().length);
  });
});

describe("debounce & coalesce", () => {
  it("BURST: ten wallet events inside the window coalesce into exactly ONE invalidation and ONE fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);

    renderWithClient(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    await settle();
    source().emitOpen();
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(1); // catch-up settled; burst starts clean

    for (let i = 0; i < 10; i += 1) {
      source().emitNamed("wallet"); // a provider settling a burst of spins
      await settle(20);
    }
    expect(realtimeInvalidations()).toHaveLength(1); // still pending — nothing premature

    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(2); // ten signals → one validated re-read
    expect(fetchMock).toHaveBeenCalledTimes(1 + realtimeInvalidations().length);
  });

  it("SPACED: events separated by more than the window each earn their own invalidation", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);

    renderWithClient(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    await settle();
    source().emitOpen();
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(1);

    source().emitNamed("wallet");
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(2);

    await settle(500); // idle gap — well past the window
    source().emitNamed("wallet");
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1 + realtimeInvalidations().length);
  });

  it("CONTINUOUS STREAM: the max-coalesce ceiling forces a flush mid-stream — sustained events can never starve invalidation", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);

    renderWithClient(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    await settle();
    source().emitOpen();
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    const baseline = realtimeInvalidations().length; // the settled catch-up
    expect(baseline).toBe(1);

    // An event every 100ms — a naive trailing debounce would reschedule forever.
    for (let step = 0; step <= 11; step += 1) {
      source().emitNamed("wallet");
      await settle(100);
    }
    // MID-STREAM (events still arriving): the 1s ceiling already forced a re-read.
    expect(realtimeInvalidations().length).toBeGreaterThan(baseline);

    for (let step = 0; step <= 10; step += 1) {
      source().emitNamed("wallet");
      await settle(100);
    }
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS); // tail flush after the stream ends

    const flushes = realtimeInvalidations().length - baseline;
    expect(flushes).toBeGreaterThanOrEqual(2); // ~2.3s of sustained events → ceiling-paced reads
    expect(flushes).toBeLessThanOrEqual(3); // …but still coalesced, never one fetch per event
    expect(fetchMock).toHaveBeenCalledTimes(1 + realtimeInvalidations().length);
  });
});

describe("lifecycle hygiene", () => {
  it("UNMOUNT mid-debounce cancels the pending invalidation and closes the stream — zero afterlife", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);

    const view = renderWithClient(
      <>
        <Bridge />
        <Probe />
      </>,
    );
    await settle();
    source().emitOpen();
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    const settled = realtimeInvalidations().length;
    expect(settled).toBe(1);

    source().emitNamed("wallet"); // schedules a flush…
    view.unmount(); // …but the app goes away first
    act(() => {
      vi.runAllTimers(); // the would-be flush window AND the deferred close both elapse
    });

    expect(realtimeInvalidations()).toHaveLength(settled); // the pending flush never fired
    expect(source().closed).toBe(true); // and the stream did not outlive its consumer
  });

  it("STRICTMODE: the dev double-mount yields one stream, ONE subscription set, one catch-up", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);

    renderWithClient(
      <StrictMode>
        <Bridge />
        <Probe />
      </StrictMode>,
    );
    await settle();
    expect(FakeEventSource.instances).toHaveLength(1); // lifecycle immunity holds via the bridge

    source().emitOpen();
    await settle(REALTIME_INVALIDATE_DEBOUNCE_MS);
    expect(realtimeInvalidations()).toHaveLength(1); // not two — the ghost subscription is gone
    expect(fetchMock).toHaveBeenCalledTimes(2); // mount read + one catch-up
  });
});
