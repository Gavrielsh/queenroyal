import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv, resetEnvCacheForTests } from "../src/config/env";
import { assertProvidersConfigured } from "../src/lib/boot-checks";
import { getKycProvider, setKycProvider } from "../src/lib/kyc";
import { getPaymentProvider, setPaymentProvider } from "../src/lib/payments";
import { getPayoutProvider, setPayoutProvider } from "../src/lib/payouts";

/**
 * Production guards that must hold BEFORE the first request.
 *
 * The mock providers mint coins, pay nobody and verify everyone, so they may run only where
 * someone has positively declared a development or test box. The parsed NODE_ENV defaults to
 * "development", which is exactly why these tests unset the RAW variable: a deployment that
 * forgets NODE_ENV must be refused, not waved through as a dev machine.
 */

function resetSingletons(): void {
  resetEnvCacheForTests();
  setPaymentProvider(null);
  setPayoutProvider(null);
  setKycProvider(null);
}

beforeEach(resetSingletons);
afterEach(() => {
  vi.unstubAllEnvs();
  resetSingletons();
});

describe("mock providers require an EXPLICIT development/test NODE_ENV", () => {
  it.each([
    ["the PSP", () => getPaymentProvider()],
    ["the payout rail", () => getPayoutProvider()],
    ["the KYC provider", () => getKycProvider()],
  ])("refuses %s when NODE_ENV is unset", (_label, get) => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(get).toThrow(/NODE_ENV/);
  });

  it("refuses the mocks when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    expect(() => getPaymentProvider()).toThrow();
    expect(() => getPayoutProvider()).toThrow();
    expect(() => getKycProvider()).toThrow();
  });

  it("allows the mocks when NODE_ENV is explicitly test", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(getPaymentProvider().name).toBe("mock");
    expect(() => getPayoutProvider()).not.toThrow();
    expect(() => getKycProvider()).not.toThrow();
  });
});

describe("assertProvidersConfigured() — fails at boot, not at the first purchase", () => {
  it("throws when any provider would be refused", () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(() => assertProvidersConfigured()).toThrow(/NODE_ENV/);
  });

  it("passes on a declared test box", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() => assertProvidersConfigured()).not.toThrow();
  });
});

describe("production refuses to boot with geo enforcement weakened", () => {
  it("refuses GEO_ENFORCEMENT_DISABLED in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    vi.stubEnv("GEO_ENFORCEMENT_DISABLED", "disabled");
    expect(() => getEnv()).toThrow(/GEO_ENFORCEMENT_DISABLED/);
  });

  it("refuses an empty TRUSTED_PROXIES in production, which would reject every player", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GEO_ENFORCEMENT_DISABLED", "");
    vi.stubEnv("TRUSTED_PROXIES", "");
    expect(() => getEnv()).toThrow(/TRUSTED_PROXIES/);
  });

  it("boots in production with enforcement on and a trusted proxy declared", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GEO_ENFORCEMENT_DISABLED", "");
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    expect(() => getEnv()).not.toThrow();
  });
});
