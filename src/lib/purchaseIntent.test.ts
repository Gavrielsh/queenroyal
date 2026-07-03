import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PurchaseIntentModule = typeof import("@/lib/purchaseIntent");

/** Deterministic BroadcastChannel double: captures posts, injects peer messages. */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  static failConstruct = false;
  static failPost = false;

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posted: unknown[] = [];

  constructor(readonly name: string) {
    if (FakeBroadcastChannel.failConstruct) throw new Error("channel unavailable");
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (FakeBroadcastChannel.failPost) throw new Error("post failed");
    this.posted.push(data);
  }

  close(): void {}

  /** Simulate a message arriving from another tab. */
  emitPeer(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const PKG = "pkg_starter_5";
const STORAGE_KEY = `qr_purchase_attempt:${PKG}`;

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  FakeBroadcastChannel.instances = [];
  FakeBroadcastChannel.failConstruct = false;
  FakeBroadcastChannel.failPost = false;
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadModule(): Promise<PurchaseIntentModule> {
  return import("@/lib/purchaseIntent");
}

function emittedEvents(): Array<Record<string, unknown>> {
  return [...infoSpy.mock.calls, ...warnSpy.mock.calls]
    .map((call) => call[1] as Record<string, unknown> | undefined)
    .filter((record): record is Record<string, unknown> => typeof record?.evt === "string");
}

function eventsNamed(evt: string): Array<Record<string, unknown>> {
  return emittedEvents().filter((record) => record.evt === evt);
}

describe("token lifecycle — mint, reuse, rotate", () => {
  it("mints once, persists to localStorage, and emits purchase.token.minted", async () => {
    const mod = await loadModule();

    const token = mod.getOrCreateAttemptToken(PKG);

    expect(token.length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(token);
    expect(eventsNamed("purchase.token.minted")).toHaveLength(1);
    expect(eventsNamed("purchase.token.minted")[0]).toMatchObject({ packageId: PKG });
  });

  it("a same-tab retry reuses the identical token (memory) without re-minting", async () => {
    const mod = await loadModule();
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");

    const first = mod.getOrCreateAttemptToken(PKG);
    const second = mod.getOrCreateAttemptToken(PKG);

    expect(second).toBe(first);
    expect(uuidSpy).toHaveBeenCalledTimes(1);
    expect(eventsNamed("purchase.token.reused")[0]).toMatchObject({ packageId: PKG, source: "memory" });
  });

  it("a NEW TAB adopts the token another tab persisted (the cross-tab retry fix)", async () => {
    window.localStorage.setItem(STORAGE_KEY, "token-from-tab-a");
    const mod = await loadModule(); // fresh module state = a fresh tab

    const token = mod.getOrCreateAttemptToken(PKG);

    expect(token).toBe("token-from-tab-a");
    expect(eventsNamed("purchase.token.minted")).toHaveLength(0);
    expect(eventsNamed("purchase.token.reused")[0]).toMatchObject({ packageId: PKG, source: "storage" });
  });

  it("peekAttemptToken is a pure probe: null before, token after, zero telemetry", async () => {
    const mod = await loadModule();

    expect(mod.peekAttemptToken(PKG)).toBeNull();
    const token = mod.getOrCreateAttemptToken(PKG);
    infoSpy.mockClear();

    expect(mod.peekAttemptToken(PKG)).toBe(token);
    expect(emittedEvents()).toHaveLength(0);
  });

  it("markSettled clears both layers, emits, broadcasts, and the next purchase mints fresh", async () => {
    const mod = await loadModule();
    const first = mod.getOrCreateAttemptToken(PKG);

    mod.markSettled(PKG);

    expect(mod.peekAttemptToken(PKG)).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(eventsNamed("purchase.token.cleared")[0]).toMatchObject({ packageId: PKG, outcome: "settled" });
    expect(FakeBroadcastChannel.instances[0]?.posted).toContainEqual({ packageId: PKG, state: "settled" });

    const next = mod.getOrCreateAttemptToken(PKG);
    expect(next).not.toBe(first);
    expect(eventsNamed("purchase.token.minted")).toHaveLength(2);
  });

  it("markAbandoned rotates with outcome 'abandoned'", async () => {
    const mod = await loadModule();
    mod.getOrCreateAttemptToken(PKG);

    mod.markAbandoned(PKG);

    expect(eventsNamed("purchase.token.cleared")[0]).toMatchObject({ outcome: "abandoned" });
    expect(FakeBroadcastChannel.instances[0]?.posted).toContainEqual({ packageId: PKG, state: "abandoned" });
  });

  it("clearing an unknown package (double-settle) is a quiet no-op: no throw, no emit, no broadcast", async () => {
    const mod = await loadModule();

    expect(() => mod.markSettled("pkg_never_bought")).not.toThrow();
    expect(eventsNamed("purchase.token.cleared")).toHaveLength(0);
    expect(FakeBroadcastChannel.instances[0]?.posted ?? []).toHaveLength(0);
  });

  it("packages are isolated: settling one keeps the other's token", async () => {
    const mod = await loadModule();
    const a = mod.getOrCreateAttemptToken("pkg_a");
    const b = mod.getOrCreateAttemptToken("pkg_b");
    expect(a).not.toBe(b);

    mod.markSettled("pkg_a");

    expect(mod.peekAttemptToken("pkg_a")).toBeNull();
    expect(mod.peekAttemptToken("pkg_b")).toBe(b);
  });
});

describe("defensive storage — the module never throws into the money flow", () => {
  it("getItem throwing (private mode): memory-only retention still keeps retries stable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const mod = await loadModule();

    let first = "";
    let second = "";
    expect(() => {
      first = mod.getOrCreateAttemptToken(PKG);
      second = mod.getOrCreateAttemptToken(PKG);
    }).not.toThrow();
    expect(second).toBe(first);
  });

  it("setItem throwing (quota): the mint still succeeds and stays retry-safe in memory", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const mod = await loadModule();

    const first = mod.getOrCreateAttemptToken(PKG);
    expect(mod.getOrCreateAttemptToken(PKG)).toBe(first);
    expect(eventsNamed("purchase.token.reused")[0]).toMatchObject({ source: "memory" });
  });

  it("removeItem throwing: the SPENT token is tombstoned, never resurrected from stale storage", async () => {
    const mod = await loadModule();
    const spent = mod.getOrCreateAttemptToken(PKG);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(() => mod.markSettled(PKG)).not.toThrow();
    expect(FakeBroadcastChannel.instances[0]?.posted).toContainEqual({ packageId: PKG, state: "settled" });
    // The stale localStorage copy survives the failed removal, but reads must hide it:
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(spent);
    expect(mod.peekAttemptToken(PKG)).toBeNull();
    // …and the NEXT logical purchase mints FRESH — a spent idempotency token riding into a
    // new purchase would false-dedupe it against the already-settled intent.
    const next = mod.getOrCreateAttemptToken(PKG);
    expect(next).not.toBe(spent);
  });

  it("a peer's terminal outcome with broken removeItem also tombstones the stale copy", async () => {
    const mod = await loadModule();
    const spent = mod.getOrCreateAttemptToken(PKG);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });

    FakeBroadcastChannel.instances[0]?.emitPeer({ packageId: PKG, state: "settled" });

    expect(mod.peekAttemptToken(PKG)).toBeNull();
    expect(mod.getOrCreateAttemptToken(PKG)).not.toBe(spent);
  });

  it("SSR (no window): memory-only lifecycle works and nothing throws", async () => {
    vi.stubGlobal("window", undefined);
    const mod = await loadModule();

    let token = "";
    expect(() => {
      token = mod.getOrCreateAttemptToken(PKG);
      expect(mod.peekAttemptToken(PKG)).toBe(token);
      mod.markSettled(PKG);
    }).not.toThrow();
    expect(token.length).toBeGreaterThan(0);
    expect(mod.peekAttemptToken(PKG)).toBeNull();
  });

  it("BroadcastChannel entirely ABSENT (legacy engines): storage events carry the peer protocol", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const mod = await loadModule();
    const seen: unknown[] = [];
    mod.onPeerActivity((event) => seen.push(event));
    mod.getOrCreateAttemptToken(PKG);

    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: null }));

    expect(seen).toContainEqual({ packageId: PKG, state: "cleared" });
    expect(mod.peekAttemptToken(PKG)).toBeNull();
  });

  it("BroadcastChannel constructor throwing degrades to the storage-event fallback", async () => {
    FakeBroadcastChannel.failConstruct = true;
    const mod = await loadModule();
    const seen: unknown[] = [];
    mod.onPeerActivity((event) => seen.push(event));
    mod.getOrCreateAttemptToken(PKG);

    // No channel — a peer clearing localStorage is the fallback terminal signal.
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: null }));

    expect(seen).toContainEqual({ packageId: PKG, state: "cleared" });
    expect(mod.peekAttemptToken(PKG)).toBeNull();
  });

  it("postMessage throwing: settle still completes; no broadcast telemetry is fabricated", async () => {
    FakeBroadcastChannel.failPost = true;
    const mod = await loadModule();
    mod.getOrCreateAttemptToken(PKG);

    expect(() => mod.markSettled(PKG)).not.toThrow();
    expect(mod.peekAttemptToken(PKG)).toBeNull();
    expect(eventsNamed("purchase.tab.broadcast")).toHaveLength(0);
  });

  it("window.addEventListener throwing during wiring is swallowed", async () => {
    vi.spyOn(window, "addEventListener").mockImplementationOnce(() => {
      throw new Error("hostile embedder");
    });
    const mod = await loadModule();

    expect(() => mod.getOrCreateAttemptToken(PKG)).not.toThrow();
  });

  it("randomUUID unavailable: falls back to getRandomValues hex entropy", async () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });
    const mod = await loadModule();

    const token = mod.getOrCreateAttemptToken(PKG);

    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("peer protocol — BroadcastChannel + storage-event fallback", () => {
  it("a peer 'settled' message drops the local token and notifies subscribers", async () => {
    const mod = await loadModule();
    const seen: unknown[] = [];
    mod.onPeerActivity((event) => seen.push(event));
    mod.getOrCreateAttemptToken(PKG);

    FakeBroadcastChannel.instances[0]?.emitPeer({ packageId: PKG, state: "settled" });

    expect(mod.peekAttemptToken(PKG)).toBeNull();
    expect(seen).toContainEqual({ packageId: PKG, state: "settled" });
  });

  it("a non-terminal peer state (in_flight) notifies WITHOUT dropping the token", async () => {
    const mod = await loadModule();
    const seen: unknown[] = [];
    mod.onPeerActivity((event) => seen.push(event));
    const token = mod.getOrCreateAttemptToken(PKG);

    FakeBroadcastChannel.instances[0]?.emitPeer({ packageId: PKG, state: "in_flight" });

    expect(seen).toContainEqual({ packageId: PKG, state: "in_flight" });
    expect(mod.peekAttemptToken(PKG)).toBe(token);
  });

  it("malformed peer messages are ignored without throwing", async () => {
    const mod = await loadModule();
    const seen: unknown[] = [];
    mod.onPeerActivity((event) => seen.push(event));
    mod.getOrCreateAttemptToken(PKG);
    const channel = FakeBroadcastChannel.instances[0];

    expect(() => {
      channel?.emitPeer(null);
      channel?.emitPeer("junk");
      channel?.emitPeer({});
      channel?.emitPeer({ packageId: "" , state: "settled" });
      channel?.emitPeer({ packageId: PKG, state: "exploded" });
    }).not.toThrow();

    expect(seen).toHaveLength(0);
    expect(mod.peekAttemptToken(PKG)).not.toBeNull();
  });

  it("a peer tab's mint is adopted via the storage event (both tabs retry with ONE token)", async () => {
    const mod = await loadModule();
    mod.getOrCreateAttemptToken(PKG);

    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: "token-from-peer" }));

    expect(mod.peekAttemptToken(PKG)).toBe("token-from-peer");
    infoSpy.mockClear();
    expect(mod.getOrCreateAttemptToken(PKG)).toBe("token-from-peer");
    expect(eventsNamed("purchase.token.reused")[0]).toMatchObject({ source: "memory" });
  });

  it("with a live channel, a storage deletion keeps memory consistent but does NOT double-notify", async () => {
    const mod = await loadModule();
    const seen: unknown[] = [];
    mod.onPeerActivity((event) => seen.push(event));
    mod.getOrCreateAttemptToken(PKG);

    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: null }));

    expect(seen).toHaveLength(0); // the channel's richer message is the single notification
    expect(mod.peekAttemptToken(PKG)).toBeNull();
  });

  it("storage events for foreign keys are ignored", async () => {
    const mod = await loadModule();
    const seen: unknown[] = [];
    mod.onPeerActivity((event) => seen.push(event));
    const token = mod.getOrCreateAttemptToken(PKG);

    window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    window.dispatchEvent(new StorageEvent("storage", { key: "qr_access_token", newValue: "x" }));

    expect(seen).toHaveLength(0);
    expect(mod.peekAttemptToken(PKG)).toBe(token);
  });

  it("unsubscribe stops delivery; a throwing listener never breaks its siblings", async () => {
    const mod = await loadModule();
    const seenByHealthy: unknown[] = [];
    const unsubscribeThrowing = mod.onPeerActivity(() => {
      throw new Error("consumer bug");
    });
    mod.onPeerActivity((event) => seenByHealthy.push(event));
    mod.getOrCreateAttemptToken(PKG);
    const channel = FakeBroadcastChannel.instances[0];

    expect(() => channel?.emitPeer({ packageId: PKG, state: "in_flight" })).not.toThrow();
    expect(seenByHealthy).toHaveLength(1);

    unsubscribeThrowing();
    channel?.emitPeer({ packageId: PKG, state: "released" });
    expect(seenByHealthy).toHaveLength(2);
  });
});

describe("FinTech logging discipline", () => {
  it("the token value NEVER appears in any telemetry record", async () => {
    const mod = await loadModule();

    const token = mod.getOrCreateAttemptToken(PKG);
    mod.getOrCreateAttemptToken(PKG); // reuse
    mod.markSettled(PKG);

    const allLoggedText = [...infoSpy.mock.calls, ...warnSpy.mock.calls]
      .map((call) => JSON.stringify(call))
      .join("\n");
    expect(allLoggedText).not.toContain(token);
    // Sanity: telemetry DID fire — we're proving redaction, not silence.
    expect(eventsNamed("purchase.token.minted")).toHaveLength(1);
    expect(eventsNamed("purchase.token.cleared")).toHaveLength(1);
    expect(eventsNamed("purchase.tab.broadcast")).toHaveLength(1);
  });
});
