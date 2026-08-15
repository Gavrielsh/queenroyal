import { describe, expect, it } from "vitest";

import { assertGeoAllowed, GeoBlockedError, type GeoPolicy, parseTrustedProxies, resolveClientIp } from "../src/lib/geo";

/** Build an explicit policy so these tests never depend on ambient env. */
function policy(overrides: Partial<GeoPolicy> = {}): GeoPolicy {
  return {
    enabled: true,
    blocked: new Set(["US-WA", "US-ID", "US-TN", "US-WY"]),
    trusted: parseTrustedProxies(["10.0.0.0/8"]),
    countryHeader: "cf-ipcountry",
    regionHeader: "cf-region-code",
    ...overrides,
  };
}

/** A header getter from a plain map. */
function headers(map: Record<string, string>) {
  return (name: string) => map[name];
}

/**
 * Run the gate and return the rejection reason, or null when admitted.
 *
 * A trusted edge always forwards a client address, so the helper supplies a
 * default `x-forwarded-for` unless the case sets one explicitly — otherwise
 * every trusted-edge case would trip `no_client_ip` before reaching the check
 * it is actually exercising.
 */
function decide(
  socketIp: string | undefined,
  map: Record<string, string>,
  p: GeoPolicy = policy(),
): string | null {
  const withForwarded = { "x-forwarded-for": "203.0.113.20", ...map };
  try {
    assertGeoAllowed({ socketIp, header: headers(withForwarded) }, p);
    return null;
  } catch (err) {
    if (err instanceof GeoBlockedError) return err.reason;
    throw err;
  }
}

describe("resolveClientIp", () => {
  const trusted = parseTrustedProxies(["10.0.0.0/8", "172.16.0.0/12"]);

  it("returns the socket peer when it is not a trusted proxy", () => {
    // The forwarded header is attacker-controlled here and must be ignored.
    expect(resolveClientIp("203.0.113.7", "8.8.8.8", trusted)).toBe("203.0.113.7");
  });

  it("honours the forwarded chain behind a trusted proxy", () => {
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", trusted)).toBe("203.0.113.7");
  });

  it("walks the chain right-to-left past trusted hops", () => {
    // "8.8.8.8" is a decoy the client prepended; the real peer was appended by
    // our edge, and the rightmost entry is an internal hop.
    expect(resolveClientIp("10.0.0.5", "8.8.8.8, 203.0.113.7, 172.16.0.9", trusted)).toBe("203.0.113.7");
  });

  it("returns null when a trusted proxy forwarded nothing", () => {
    expect(resolveClientIp("10.0.0.5", undefined, trusted)).toBeNull();
  });

  it("returns null when every hop is a trusted proxy", () => {
    expect(resolveClientIp("10.0.0.5", "10.0.0.1, 10.0.0.2", trusted)).toBeNull();
  });

  it("returns null on a malformed hop rather than guessing", () => {
    expect(resolveClientIp("10.0.0.5", "not-an-ip", trusted)).toBeNull();
  });

  it("returns null for an unparseable socket address", () => {
    expect(resolveClientIp("garbage", "203.0.113.7", trusted)).toBeNull();
  });

  it("supports bare-IP and IPv6 trusted entries", () => {
    const t = parseTrustedProxies(["192.168.1.1", "2001:db8::/32"]);
    expect(resolveClientIp("192.168.1.1", "203.0.113.7", t)).toBe("203.0.113.7");
    expect(resolveClientIp("2001:db8::1", "203.0.113.7", t)).toBe("203.0.113.7");
    // Outside the trusted range → the peer itself is the client.
    expect(resolveClientIp("2001:dead::1", "203.0.113.7", t)).toBe("2001:dead::1");
  });
});

describe("parseTrustedProxies", () => {
  it("rejects a malformed entry instead of dropping it", () => {
    // Silently ignoring one would leave the geo headers trusted from an
    // unintended network — the exact spoofing hole this closes.
    expect(() => parseTrustedProxies(["not-a-cidr"])).toThrow(/not a valid IP or CIDR/);
    expect(() => parseTrustedProxies(["10.0.0.0/99"])).toThrow(/invalid prefix length/);
  });

  it("ignores blank entries", () => {
    expect(parseTrustedProxies(["", "  ", "10.0.0.0/8"])).toHaveLength(1);
  });
});

describe("assertGeoAllowed", () => {
  it("admits a permitted region behind a trusted edge", () => {
    expect(decide("10.0.0.5", { "cf-ipcountry": "US", "cf-region-code": "NJ" })).toBeNull();
  });

  it.each([
    ["WA", "Washington"],
    ["ID", "Idaho"],
    ["TN", "Tennessee"],
    ["WY", "Wyoming"],
  ])("blocks US-%s (%s)", (code) => {
    expect(decide("10.0.0.5", { "cf-ipcountry": "US", "cf-region-code": code })).toBe("blocked_region");
  });

  it("is case-insensitive on the edge headers", () => {
    expect(decide("10.0.0.5", { "cf-ipcountry": "us", "cf-region-code": "wa" })).toBe("blocked_region");
  });

  // ── FAIL CLOSED ────────────────────────────────────────────────────────────

  it("rejects when the edge could not resolve a subdivision", () => {
    // Routine for mobile/CGNAT — and previously the most common silent admit.
    expect(decide("10.0.0.5", { "cf-ipcountry": "US" })).toBe("region_unknown");
    expect(decide("10.0.0.5", {})).toBe("region_unknown");
  });

  it("rejects when the peer is not a trusted edge, even with geo headers set", () => {
    // A player hitting the gateway directly can set these headers themselves,
    // so they must carry no weight.
    expect(
      decide("203.0.113.7", { "cf-ipcountry": "US", "cf-region-code": "NJ" }),
    ).toBe("no_trusted_edge");
  });

  it("rejects when the client IP cannot be resolved", () => {
    expect(decide(undefined, { "cf-ipcountry": "US", "cf-region-code": "NJ" })).toBe("no_client_ip");
    expect(decide("10.0.0.5", { "cf-ipcountry": "US", "cf-region-code": "NJ", "x-forwarded-for": "bad" })).toBe(
      "no_client_ip",
    );
  });

  it("rejects everything when no proxy is trusted (safe default)", () => {
    // An operator who forgets TRUSTED_PROXIES gets a loud, total failure
    // rather than a fence that quietly trusts a spoofable header.
    const p = policy({ trusted: parseTrustedProxies([]) });
    expect(decide("203.0.113.7", { "cf-ipcountry": "US", "cf-region-code": "NJ" }, p)).toBe("no_trusted_edge");
  });

  // ── Opacity ────────────────────────────────────────────────────────────────

  it("presents an identical message and status for every rejection", () => {
    const reasons = [
      decide("10.0.0.5", { "cf-ipcountry": "US", "cf-region-code": "WA" }),
      decide("10.0.0.5", {}),
      decide("203.0.113.7", {}),
    ];
    // Reasons differ internally (for logs)…
    expect(new Set(reasons).size).toBeGreaterThan(1);

    // …but the caller-visible surface must not.
    const errs = [
      new GeoBlockedError("blocked_region"),
      new GeoBlockedError("region_unknown"),
      new GeoBlockedError("no_trusted_edge"),
    ];
    expect(new Set(errs.map((e) => e.message)).size).toBe(1);
    expect(new Set(errs.map((e) => e.status)).size).toBe(1);
    expect(new Set(errs.map((e) => e.code)).size).toBe(1);
  });

  // ── Explicit opt-out ───────────────────────────────────────────────────────

  it("admits everything only when enforcement is explicitly disabled", () => {
    const p = policy({ enabled: false });
    expect(decide("203.0.113.7", { "cf-ipcountry": "US", "cf-region-code": "WA" }, p)).toBeNull();
  });
});
