import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSseWalletChannel } from "@/lib/realtime/sseChannel";
import type { ChannelStatus } from "@/lib/realtime/walletChannel";

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

function makeChannel(overrides: { jitter?: () => number; heartbeatTimeoutMs?: number } = {}) {
  return createSseWalletChannel("http://localhost:4000/api/wallet/stream", {
    eventSourceFactory: (url) => new FakeEventSource(url) as unknown as EventSource,
    jitter: overrides.jitter ?? (() => 0.5),
    heartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 45_000,
    backoffBaseMs: 1_000,
    backoffCapMs: 30_000,
  });
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error("no EventSource constructed");
  return source;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection lifecycle", () => {
  it("connect opens one stream; open transitions connecting → healthy", () => {
    const channel = makeChannel();
    const statuses: ChannelStatus[] = [];
    channel.onStatus((next) => statuses.push(next));

    channel.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(channel.getStatus()).toBe("connecting");

    lastSource().emitOpen();
    expect(channel.getStatus()).toBe("healthy");
    expect(statuses).toEqual(["connecting", "healthy"]);
  });

  it("connect is idempotent while live and while a reconnect is pending", () => {
    const channel = makeChannel();
    channel.connect();
    channel.connect();
    expect(FakeEventSource.instances).toHaveLength(1);

    lastSource().emitError(); // → reconnect pending
    channel.connect();
    expect(FakeEventSource.instances).toHaveLength(1); // the pending timer owns reopening
  });

  it("close cancels reconnects, closes and NULLIFIES the stream, and is idempotent", () => {
    const channel = makeChannel();
    channel.connect();
    const first = lastSource();
    first.emitError(); // schedules a reconnect

    channel.close();
    channel.close();

    expect(first.closed).toBe(true);
    expect(channel.getStatus()).toBe("closed");
    vi.advanceTimersByTime(60_000); // the cancelled reconnect must never fire
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("jittered exponential backoff (thundering-herd protection)", () => {
  it("reconnects on the equal-jitter exponential ladder: 750ms, 1.5s, 3s… with jitter=0.5", () => {
    const channel = makeChannel({ jitter: () => 0.5 });
    channel.connect();

    // Attempt 1: raw=1000 → delay = 500 + 0.5·500 = 750ms.
    lastSource().emitError();
    vi.advanceTimersByTime(749);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Attempt 2 (no successful open in between): raw=2000 → delay 1500ms.
    lastSource().emitError();
    vi.advanceTimersByTime(1_499);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    // Attempt 3: raw=4000 → delay 3000ms.
    lastSource().emitError();
    vi.advanceTimersByTime(3_000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("the delay is genuinely randomized by the jitter source", () => {
    const floorChannel = makeChannel({ jitter: () => 0 });
    floorChannel.connect();
    lastSource().emitError();
    vi.advanceTimersByTime(500); // raw/2 + 0·raw/2 = 500ms floor
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.instances = [];
    const ceilChannel = makeChannel({ jitter: () => 1 });
    ceilChannel.connect();
    lastSource().emitError();
    vi.advanceTimersByTime(999); // raw/2 + 1·raw/2 = 1000ms ceiling
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("backoff caps: deep attempts never exceed cap-derived delays", () => {
    const channel = makeChannel({ jitter: () => 1 }); // ceiling: delay = raw
    channel.connect();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      lastSource().emitError();
      vi.advanceTimersByTime(30_000); // cap: even attempt 8 reopens within 30s
    }
    expect(FakeEventSource.instances).toHaveLength(9);
  });

  it("a successful open RESETS the ladder", () => {
    const channel = makeChannel({ jitter: () => 0.5 });
    channel.connect();
    lastSource().emitError();
    vi.advanceTimersByTime(750);
    lastSource().emitError();
    vi.advanceTimersByTime(1_500); // ladder is at attempt 2

    lastSource().emitOpen(); // healthy again
    lastSource().emitError(); // next failure starts over
    vi.advanceTimersByTime(750); // attempt-1 delay again
    expect(FakeEventSource.instances).toHaveLength(4);
  });
});

describe("heartbeat watchdog (silent-drop detection)", () => {
  it("server heartbeats keep a silent-but-alive stream healthy", () => {
    const channel = makeChannel({ heartbeatTimeoutMs: 45_000 });
    channel.connect();
    lastSource().emitOpen();

    vi.advanceTimersByTime(44_000);
    lastSource().emitNamed("heartbeat"); // re-arms with 1s to spare
    vi.advanceTimersByTime(44_000);
    lastSource().emitNamed("heartbeat");

    expect(channel.getStatus()).toBe("healthy");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("heartbeat silence past the budget terminates and recycles the connection", () => {
    const channel = makeChannel({ heartbeatTimeoutMs: 45_000, jitter: () => 0.5 });
    const statuses: ChannelStatus[] = [];
    channel.onStatus((next) => statuses.push(next));
    channel.connect();
    const first = lastSource();
    first.emitOpen();

    vi.advanceTimersByTime(45_000); // watchdog fires

    expect(first.closed).toBe(true); // manually terminated — onerror never fired
    expect(channel.getStatus()).toBe("degraded");
    vi.advanceTimersByTime(750); // recycled on the backoff ladder
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(statuses).toEqual(["connecting", "healthy", "degraded"]);
  });

  it("wallet events also feed the watchdog", () => {
    const channel = makeChannel({ heartbeatTimeoutMs: 45_000 });
    channel.connect();
    lastSource().emitOpen();

    vi.advanceTimersByTime(44_000);
    lastSource().emitNamed("wallet");
    vi.advanceTimersByTime(44_000);

    expect(channel.getStatus()).toBe("healthy");
  });
});

describe("opaque wallet notifications (single source of truth)", () => {
  it("a wallet event notifies subscribers with NO payload", () => {
    const channel = makeChannel();
    const received: unknown[] = [];
    channel.onWalletEvent((...args: unknown[]) => received.push(args));
    channel.connect();
    lastSource().emitOpen();

    lastSource().emitNamed("wallet");
    lastSource().emitNamed("wallet");

    expect(received).toEqual([[], []]); // bare signals — zero arguments, zero payload
  });

  it("unsubscribe stops delivery; a throwing subscriber never breaks its siblings", () => {
    const channel = makeChannel();
    const seen: string[] = [];
    const unsubscribeThrowing = channel.onWalletEvent(() => {
      throw new Error("consumer bug");
    });
    channel.onWalletEvent(() => seen.push("ok"));
    channel.connect();
    lastSource().emitOpen();

    expect(() => lastSource().emitNamed("wallet")).not.toThrow();
    expect(seen).toEqual(["ok"]);

    unsubscribeThrowing();
    lastSource().emitNamed("wallet");
    expect(seen).toEqual(["ok", "ok"]);
  });

  it("telemetry narrates the lifecycle: connected, then disconnected with a reason", () => {
    const info = vi.mocked(console.info);
    const channel = makeChannel({ heartbeatTimeoutMs: 45_000 });
    channel.connect();
    lastSource().emitOpen();
    vi.advanceTimersByTime(45_000); // heartbeat timeout

    const events = [...info.mock.calls]
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .filter((record): record is Record<string, unknown> =>
        typeof record?.evt === "string" && String(record.evt).startsWith("wallet.realtime"),
      );
    expect(events[0]).toMatchObject({ evt: "wallet.realtime.connected" });
    expect(events[1]).toMatchObject({ evt: "wallet.realtime.disconnected", reason: "heartbeat_timeout" });
  });
});
