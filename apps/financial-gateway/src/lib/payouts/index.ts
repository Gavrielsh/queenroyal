import { getEnv } from "../../config/env";
import { MockPayoutProvider } from "./mock";
import { type PayoutProvider, PayoutProviderNotConfiguredError } from "./types";

export * from "./types";
export { MockPayoutProvider };

let instance: PayoutProvider | null = null;

/**
 * The configured payout rail (singleton).
 *
 * Only the mock exists today, and it is FORBIDDEN in production for the same reason the mock
 * PSP is: a rail that reports `paid` without moving money would mark redemptions settled that
 * no player ever received — and unlike a bad deposit, nobody complains about money they were
 * told they got. Booting production without a real rail fails loudly here rather than paying
 * nobody quietly.
 */
export function getPayoutProvider(): PayoutProvider {
  if (instance) return instance;
  if (getEnv().NODE_ENV === "production") {
    throw new PayoutProviderNotConfiguredError(
      "no real payout rail is configured — the mock provider is forbidden in production",
    );
  }
  instance = new MockPayoutProvider();
  return instance;
}

/** Override the rail (tests / DI). Pass null to reset to the env-derived default. */
export function setPayoutProvider(provider: PayoutProvider | null): void {
  instance = provider;
}
