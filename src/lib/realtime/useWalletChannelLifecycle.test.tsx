import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * StrictMode-immunity suite for the channel lifecycle hook. Module state (consumer count,
 * channel singleton) is reset per test via resetModules + dynamic import; EventSource is
 * globally stubbed (jsdom ships none) so the REAL default factory path is exercised.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

const CHANNEL_URL = "http://localhost:4000/api/wallet/stream";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadHook() {
  const mod = await import("@/lib/realtime/useWalletChannelLifecycle");
  return mod.useWalletChannelLifecycle;
}

describe("useWalletChannelLifecycle — StrictMode immunity + flag fallback", () => {
  it("FLAG UNSET: renders and unmounts with zero EventSource activity (Phase A remains the system)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", "");
    const useWalletChannelLifecycle = await loadHook();
    function Consumer() {
      useWalletChannelLifecycle();
      return null;
    }

    const { unmount } = render(
      <StrictMode>
        <Consumer />
      </StrictMode>,
    );
    unmount();
    act(() => {
      vi.runAllTimers();
    });

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("STRICTMODE: mount → cleanup → mount opens exactly ONE connection and leaks nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);
    const useWalletChannelLifecycle = await loadHook();
    function Consumer() {
      useWalletChannelLifecycle();
      return null;
    }

    const { unmount } = render(
      <StrictMode>
        <Consumer />
      </StrictMode>,
    );
    act(() => {
      vi.runAllTimers(); // any deferred release from the StrictMode cleanup must be reclaimed
    });

    // The dev double-mount reused the SAME stream: one instance, still open.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
    expect(FakeEventSource.instances[0]?.url).toBe(CHANNEL_URL);

    // The genuine final unmount closes it after the one-tick grace — zero leaks.
    unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("REF-COUNTING: the connection survives until the LAST consumer unmounts", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);
    const useWalletChannelLifecycle = await loadHook();
    function Consumer() {
      useWalletChannelLifecycle();
      return null;
    }

    const first = render(<Consumer />);
    const second = render(<Consumer />);
    act(() => {
      vi.runAllTimers();
    });
    expect(FakeEventSource.instances).toHaveLength(1);

    first.unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(FakeEventSource.instances[0]?.closed).toBe(false); // one consumer remains

    second.unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("remount AFTER a completed close opens a fresh connection (no zombie reuse)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLET_CHANNEL_URL", CHANNEL_URL);
    const useWalletChannelLifecycle = await loadHook();
    function Consumer() {
      useWalletChannelLifecycle();
      return null;
    }

    const first = render(<Consumer />);
    first.unmount();
    act(() => {
      vi.runAllTimers(); // close completes
    });
    expect(FakeEventSource.instances[0]?.closed).toBe(true);

    render(<Consumer />);
    act(() => {
      vi.runAllTimers();
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.closed).toBe(false);
  });
});
