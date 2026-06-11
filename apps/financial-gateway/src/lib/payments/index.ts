import { getEnv } from "../../config/env";
import { MockPaymentProvider } from "./mock";
import { StripePaymentProvider } from "./stripe";
import { type PaymentProvider, PaymentProviderNotConfiguredError } from "./types";

export * from "./types";

let instance: PaymentProvider | null = null;

/** The configured PSP (singleton). `mock` in dev/test; `stripe` when fully wired. */
export function getPaymentProvider(): PaymentProvider {
  if (instance) return instance;
  const env = getEnv();

  if (env.PAYMENT_PROVIDER === "stripe") {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
      throw new PaymentProviderNotConfiguredError(
        "PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET",
      );
    }
    instance = new StripePaymentProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    });
  } else {
    // The mock PSP auto-settles purchases — in production that would mint coins for free.
    if (env.NODE_ENV === "production") {
      throw new PaymentProviderNotConfiguredError(
        "PAYMENT_PROVIDER=mock is forbidden in production — configure PAYMENT_PROVIDER=stripe",
      );
    }
    instance = new MockPaymentProvider(env.PSP_WEBHOOK_SECRET ?? "mock_psp_dev_secret");
  }
  return instance;
}

/** Override the provider (tests / DI). Pass null to reset to the env-derived default. */
export function setPaymentProvider(provider: PaymentProvider | null): void {
  instance = provider;
}
