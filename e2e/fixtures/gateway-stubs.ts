import type { BrowserContext, Route } from "@playwright/test";

/**
 * Deterministic, network-isolated gateway stubs for the visual harness.
 *
 * STUB FIDELITY: every envelope below mirrors a VERIFIED wire contract from the real
 * gateway source (read during the M1/M2 hardening + the M2-T3 audit):
 *   - success envelope  → apps/financial-gateway/src/lib/reply.ts `okBody`
 *   - failure envelope  → reply.ts `errBody` — code/message NESTED under `error`
 *     (the exact shape the M1-T3 client fix parses)
 *   - GET /api/wallet   → routes/wallet.ts (verbatim engine decimal STRINGS, 4 dp)
 *   - POST /api/store/purchase → store.service.ts `PurchaseInitiated`
 *   - POST /api/store/purchase/mock-confirm → store.service.ts `MockDepositSettled`
 *   - POST /api/auth/mock-login → the dev session bootstrap consumed by DevAutoLogin
 *
 * ISOLATION: `installGateway` registers a catch-all FIRST (Playwright matches routes in
 * reverse registration order, so it matches LAST): requests to the Next dev server pass
 * through; EVERYTHING else — including any gateway endpoint not covered by the scenario —
 * is aborted and recorded as a violation the spec asserts to be empty. The real network is
 * unreachable by construction.
 */

/** Gateway origin exactly as the browser resolves it (apiClient's default base URL). */
export const GATEWAY_ORIGIN = "http://localhost:4000";

const APP_ORIGIN = "http://localhost:3000";

// ── Envelope builders (verified shapes) ─────────────────────────────────────

export function okBody<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function errBody(code: string, message: string): { success: false; error: { code: string; message: string } } {
  return { success: false, error: { code, message } };
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * DevAutoLogin stores this token, and the client's session probe decodes its `exp` claim
 * with a plain base64url parse (NO signature verification — the gateway is the only
 * verifier). The stub token therefore just needs three parts and a far-future exp.
 */
export function fakeAccessToken(): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: "user_e2e_1", exp: Math.floor(Date.now() / 1000) + 3_600 });
  return `${header}.${payload}.e2e-signature-not-verified-by-the-browser`;
}

export function mockLoginEnvelope(): unknown {
  return okBody({
    user: { id: "user_e2e_1", email: "e2e@queenroyal.test", kycStatus: "VERIFIED" },
    accessToken: fakeAccessToken(),
  });
}

export interface WalletBalances {
  gc: string;
  sc_unplayed: string;
  sc_redeemable: string;
}

/** Engine-format decimal strings (NUMERIC(18,4) wire shape), forwarded verbatim. */
export const SEED_BALANCES: WalletBalances = { gc: "1000.0000", sc_unplayed: "12.5000", sc_redeemable: "0.0000" };
export const CREDITED_BALANCES: WalletBalances = { gc: "6000.0000", sc_unplayed: "17.5000", sc_redeemable: "0.0000" };

export function walletEnvelope(balances: WalletBalances): unknown {
  return okBody({ player_id: "pl_e2e_1", balances });
}

export function purchaseIntentEnvelope(): unknown {
  return okBody({
    status: "requires_payment_confirmation",
    paymentIntentId: "pi_e2e_1",
    clientSecret: "pi_e2e_1_secret_e2e",
    operatorTransactionId: "deposit:e2e-attempt-1",
    // The gateway also returns the resolved package (client currently ignores it).
    package: { id: "pkg_starter_5", label: "Starter", gc: 5000, sc: 5, priceUsdCents: 500 },
  });
}

export function mockConfirmEnvelope(): unknown {
  return okBody({
    status: "settled",
    paymentIntentId: "pi_e2e_1",
    operatorTransactionId: "deposit:e2e-attempt-1",
    note: "PROCESSED",
  });
}

// ── Scenario wiring ──────────────────────────────────────────────────────────

async function fulfillJson(route: Route, json: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}

export type WalletScenario =
  /** Balances resolve immediately (the healthy floor). */
  | "synced"
  /** 401 with the gateway's UNAUTHORIZED envelope (the "log in" state). */
  | "unauthorized"
  /** 503 ENGINE_UNAVAILABLE — the fail-closed ledger outage (the "stale" state). */
  | "unavailable"
  /** The request never resolves — holds the UI in its loading/skeleton state. */
  | "hanging"
  /** Resolves SEED_BALANCES until mock-confirm settles, then CREDITED_BALANCES. */
  | "credit-after-purchase";

export type PurchaseScenario = "settled" | "declined" | "confirm-hanging";

export interface GatewayStubOptions {
  wallet: WalletScenario;
  purchase?: PurchaseScenario;
  login?: "ok" | "unavailable";
}

export interface InstalledGateway {
  /** Aborted requests that no stub covered — the spec asserts this stays EMPTY. */
  violations: string[];
}

export async function installGateway(
  context: BrowserContext,
  opts: GatewayStubOptions,
): Promise<InstalledGateway> {
  const violations: string[] = [];

  // Registered first ⇒ matched last: total isolation from the real network. Only the Next
  // dev server passes through; anything else is aborted and recorded.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === APP_ORIGIN) {
      await route.continue();
      return;
    }
    violations.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });

  await context.route(`${GATEWAY_ORIGIN}/api/auth/mock-login`, async (route) => {
    if ((opts.login ?? "ok") === "ok") {
      await fulfillJson(route, mockLoginEnvelope());
      return;
    }
    await fulfillJson(route, errBody("SESSION_STORE_UNAVAILABLE", "Redis is unavailable"), 503);
  });

  let credited = false;
  await context.route(`${GATEWAY_ORIGIN}/api/wallet`, async (route) => {
    switch (opts.wallet) {
      case "hanging":
        return; // deliberately unfulfilled — the request stays pending
      case "unauthorized":
        await fulfillJson(route, errBody("UNAUTHORIZED", "Authentication required"), 401);
        return;
      case "unavailable":
        await fulfillJson(route, errBody("ENGINE_UNAVAILABLE", "The ledger is temporarily unavailable"), 503);
        return;
      case "credit-after-purchase":
        await fulfillJson(route, walletEnvelope(credited ? CREDITED_BALANCES : SEED_BALANCES));
        return;
      case "synced":
        await fulfillJson(route, walletEnvelope(SEED_BALANCES));
        return;
    }
  });

  if (opts.purchase) {
    const purchase = opts.purchase;
    await context.route(`${GATEWAY_ORIGIN}/api/store/purchase`, async (route) => {
      if (purchase === "declined") {
        await fulfillJson(route, errBody("PAYMENT_DECLINED", "Card declined"), 402);
        return;
      }
      await fulfillJson(route, purchaseIntentEnvelope());
    });
    await context.route(`${GATEWAY_ORIGIN}/api/store/purchase/mock-confirm`, async (route) => {
      if (purchase === "confirm-hanging") {
        return; // deliberately unfulfilled — holds the BUYING… state
      }
      credited = true;
      await fulfillJson(route, mockConfirmEnvelope());
    });
  }

  return { violations };
}
