import { getEnv } from "../config/env";
import { getKycProvider } from "./kyc";
import { getPaymentProvider } from "./payments";
import { getPayoutProvider } from "./payouts";

/**
 * Resolve every money- and identity-bearing provider once, at process start.
 *
 * The factories refuse a mock outside a declared dev/test box, but they are lazy: without this
 * call a misconfigured process boots, passes its liveness probe, and only fails on the first
 * purchase, payout or KYC webhook — after traffic has been routed to it. Calling this from
 * every entrypoint (API server and workers) turns that into a crash at deploy time.
 */
export function assertProvidersConfigured(): void {
  getEnv();
  getPaymentProvider();
  getPayoutProvider();
  getKycProvider();
}
