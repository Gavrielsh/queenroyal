import { createHmac, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLOCK_DRIFT_TOLERANCE_MS,
  type HeaderGetter,
  type NonceStore,
  setNonceStore,
  verifyProviderWebhook,
} from "../src/lib/webhook-security";

const PROVIDER = "PRAGMATIC";
const PROVIDER_SECRET = "test-provider-secret"; // matches PROVIDER_WEBHOOK_SECRETS in test/setup.ts

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function sign(body: string, secret = PROVIDER_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function headersFor(opts: {
  body: string;
  provider?: string;
  signature?: string;
  timestamp?: number;
  nonce?: string | null;
}): HeaderGetter {
  const map: Record<string, string | undefined> = {
    "x-provider-code": opts.provider ?? PROVIDER,
    "x-signature": opts.signature ?? sign(opts.body),
    "x-timestamp": String(opts.timestamp ?? nowSeconds()),
    "x-nonce": opts.nonce === null ? undefined : (opts.nonce ?? randomUUID()),
  };
  return (name) => map[name];
}

describe("verifyProviderWebhook (zero-trust perimeter)", () => {
  // Inject an always-fresh nonce store so Redis isn't needed (replay tested separately).
  beforeEach(() => setNonceStore({ reserve: async () => true }));
  afterEach(() => setNonceStore(null));

  it("accepts a correctly-signed, fresh request", async () => {
    const body = JSON.stringify({ provider_transaction_id: "x" });
    await expect(verifyProviderWebhook(headersFor({ body }), body)).resolves.toMatchObject({ providerCode: PROVIDER });
  });

  it("rejects an unknown provider with 401", async () => {
    const body = "{}";
    await expect(verifyProviderWebhook(headersFor({ body, provider: "UNKNOWN" }), body)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      status: 401,
    });
  });

  it("rejects a bad signature with 401", async () => {
    const body = JSON.stringify({ a: 1 });
    await expect(
      verifyProviderWebhook(headersFor({ body, signature: sign(body, "wrong-secret") }), body),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", status: 401 });
  });

  it("rejects when the received body differs from the signed body (tamper)", async () => {
    const signedBody = JSON.stringify({ amount: "1" });
    const receivedBody = JSON.stringify({ amount: "9999" });
    // signature is valid for signedBody, but verification runs over receivedBody.
    await expect(verifyProviderWebhook(headersFor({ body: signedBody }), receivedBody)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("enforces a symmetric 5s clock-drift tolerance", async () => {
    expect(CLOCK_DRIFT_TOLERANCE_MS).toBe(5000);
    const body = "{}";
    await expect(verifyProviderWebhook(headersFor({ body, timestamp: nowSeconds() + 4 }), body)).resolves.toMatchObject({
      providerCode: PROVIDER,
    });
    await expect(verifyProviderWebhook(headersFor({ body, timestamp: nowSeconds() + 6 }), body)).rejects.toMatchObject({
      code: "STALE_REQUEST",
    });
    await expect(verifyProviderWebhook(headersFor({ body, timestamp: nowSeconds() - 310 }), body)).rejects.toMatchObject({
      code: "STALE_REQUEST",
    });
  });

  it("rejects a missing nonce with 400", async () => {
    const body = "{}";
    await expect(verifyProviderWebhook(headersFor({ body, nonce: null }), body)).rejects.toMatchObject({
      code: "MISSING_NONCE",
      status: 400,
    });
  });

  it("rejects a replayed nonce (single-use store)", async () => {
    const used = new Set<string>();
    const store: NonceStore = {
      reserve: async (key) => {
        if (used.has(key)) return false;
        used.add(key);
        return true;
      },
    };
    setNonceStore(store);

    const body = JSON.stringify({ z: 1 });
    const headers = headersFor({ body, nonce: randomUUID() });
    await expect(verifyProviderWebhook(headers, body)).resolves.toMatchObject({ providerCode: PROVIDER });
    await expect(verifyProviderWebhook(headers, body)).rejects.toMatchObject({ code: "REPLAY_DETECTED", status: 401 });
  });

  it("fails CLOSED (503) when no replay store is available (no Redis)", async () => {
    setNonceStore(null); // no override; REDIS_URL is unset in tests → store unavailable
    const body = "{}";
    await expect(verifyProviderWebhook(headersFor({ body }), body)).rejects.toMatchObject({
      code: "REPLAY_STORE_UNAVAILABLE",
      status: 503,
    });
  });
});
