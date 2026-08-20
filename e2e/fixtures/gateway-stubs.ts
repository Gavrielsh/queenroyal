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

/** Balances after a 1.0000 GC stake pays a 20x BELL line (bet debited, win credited). */
export const POST_SPIN_BALANCES: WalletBalances = {
  gc: "1019.0000",
  sc_unplayed: "12.5000",
  sc_redeemable: "0.0000",
};

/**
 * `POST /api/spin` success envelope — routes/spin.ts `okBody(EngineSpinResult)`.
 * Reel symbols are the engine's own ids from `internal/game/paytable.go`.
 */
export function spinEnvelope(status: "PROCESSED" | "GHOST_RECOVERED" = "PROCESSED"): unknown {
  return okBody({
    operator_transaction_id: "spin:e2e-attempt-1",
    player_id: "pl_e2e_1",
    bet_ledger_transaction_id: "ltx_bet_e2e_1",
    win_ledger_transaction_id: "ltx_win_e2e_1",
    family: "GC",
    bet_amount: "1.0000",
    win_amount: "20.0000",
    outcome: {
      game_id: "classic-3reel",
      paytable_version: "1.0.0",
      reels: ["BELL", "BELL", "BELL"],
      line: "THREE_OF_A_KIND",
      win_symbol: "BELL",
      multiplier: "20",
    },
    post_balances: POST_SPIN_BALANCES,
    status,
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
  | "credit-after-purchase"
  /** Resolves SEED_BALANCES until a spin settles, then POST_SPIN_BALANCES. */
  | "settle-after-spin";

export type PurchaseScenario = "settled" | "declined" | "confirm-hanging";

/**
 * How `POST /api/spin` behaves. Each mirrors a real gateway/engine outcome:
 *   settled            → 200, a paying round (routes/spin.ts)
 *   ghost-recovered    → 200 with status GHOST_RECOVERED (engine 23505 replay)
 *   insufficient-funds → 400 INSUFFICIENT_FUNDS (pkg/errors → httpStatusFor)
 *   unavailable        → 503 ENGINE_UNAVAILABLE (fail-closed ledger outage)
 *   in-flight          → 409 TRANSACTION_PENDING (idempotency barrier)
 *   hanging            → never resolves; holds the SPINNING… state
 */
export type SpinScenario =
  | "settled"
  | "ghost-recovered"
  | "insufficient-funds"
  | "unavailable"
  | "in-flight"
  | "hanging";

export interface GatewayStubOptions {
  wallet: WalletScenario;
  purchase?: PurchaseScenario;
  spin?: SpinScenario;
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
  let spun = false;
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
      case "settle-after-spin":
        await fulfillJson(route, walletEnvelope(spun ? POST_SPIN_BALANCES : SEED_BALANCES));
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

  if (opts.spin) {
    const spin = opts.spin;
    await context.route(`${GATEWAY_ORIGIN}/api/spin`, async (route) => {
      switch (spin) {
        case "hanging":
          return; // deliberately unfulfilled — holds the SPINNING… state
        case "insufficient-funds":
          await fulfillJson(route, errBody("INSUFFICIENT_FUNDS", "insufficient funds"), 400);
          return;
        case "unavailable":
          await fulfillJson(route, errBody("ENGINE_UNAVAILABLE", "the ledger is temporarily unavailable"), 503);
          return;
        case "in-flight":
          await fulfillJson(route, errBody("TRANSACTION_PENDING", "transaction already in flight"), 409);
          return;
        case "ghost-recovered":
          spun = true;
          await fulfillJson(route, spinEnvelope("GHOST_RECOVERED"));
          return;
        case "settled":
          spun = true;
          await fulfillJson(route, spinEnvelope("PROCESSED"));
          return;
      }
    });
  }

  return { violations };
}
