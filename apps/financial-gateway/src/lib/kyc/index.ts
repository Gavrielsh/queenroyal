import { getEnv } from "../../config/env";
import { MockKycProvider } from "./mock";
import { type KycProvider, KycProviderNotConfiguredError } from "./types";

export * from "./types";
export { MockKycProvider };

let instance: KycProvider | null = null;

/**
 * The configured identity-verification provider (singleton).
 *
 * Only the mock exists today, and it is FORBIDDEN in production for a sharper reason than the
 * mock PSP or payout rail. Those fail by moving money wrongly, which somebody eventually
 * notices and disputes. A mock KYC provider fails by marking players VERIFIED who were never
 * identified — and a verified status is the gate on redeeming real prizes, on the AML controls
 * behind it, and on the age checks the licence depends on. Nobody complains about being let
 * through, so the failure is silent until a regulator finds it.
 *
 * Booting production without a real provider therefore fails loudly here rather than verifying
 * everyone quietly.
 */
export function getKycProvider(): KycProvider {
  if (instance) return instance;
  if (getEnv().NODE_ENV === "production") {
    throw new KycProviderNotConfiguredError(
      "no real KYC provider is configured — the mock provider is forbidden in production",
    );
  }
  instance = new MockKycProvider(getEnv().KYC_WEBHOOK_SECRET);
  return instance;
}

/** Override the provider (tests / DI). Pass null to reset to the env-derived default. */
export function setKycProvider(provider: KycProvider | null): void {
  instance = provider;
}
