import { MOCK_PROVIDER_REFUSAL, mockProvidersAllowed } from "../../config/env";
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
  if (!mockProvidersAllowed()) {
    throw new PayoutProviderNotConfiguredError(`no real payout rail is configured — ${MOCK_PROVIDER_REFUSAL}`);
  }
  instance = new MockPayoutProvider();
  return instance;
}

/** Override the rail (tests / DI). Pass null to reset to the env-derived default. */
export function setPayoutProvider(provider: PayoutProvider | null): void {
  instance = provider;
}
