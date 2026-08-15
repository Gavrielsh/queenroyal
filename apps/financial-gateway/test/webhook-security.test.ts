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

/**
 * Canonical signature: HMAC(secret, "<timestamp>.<nonce>.<body>").
 *
 * The timestamp and nonce are part of the signed material, so a test must sign
 * the SAME values it sends — see headersFor, which resolves both once.
 */
function sign(timestamp: string, nonce: string, body: string, secret = PROVIDER_SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`, "utf8").digest("hex");
}

/** The PRE-AUDIT body-only signature, kept to prove it is now rejected. */
function signLegacy(body: string, secret = PROVIDER_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function headersFor(opts: {
  body: string;
  provider?: string;
  signature?: string;
  timestamp?: number;
  nonce?: string | null;
}): HeaderGetter {
  // Resolve timestamp and nonce ONCE so the signature covers exactly what is sent.
  const timestamp = String(opts.timestamp ?? nowSeconds());
  const nonce = opts.nonce === null ? undefined : (opts.nonce ?? randomUUID());

  const map: Record<string, string | undefined> = {
    "x-provider-code": opts.provider ?? PROVIDER,
    "x-signature": opts.signature ?? sign(timestamp, nonce ?? "", opts.body),
    "x-timestamp": timestamp,
    "x-nonce": nonce,
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
      verifyProviderWebhook(
        headersFor({ body, signature: sign(String(nowSeconds()), "n", body, "wrong-secret") }),
        body,
      ),
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

  // CONTRACT CHANGE: the nonce is part of the SIGNED material now, so its
  // well-formedness is checked BEFORE the MAC is computed. A missing nonce is
  // therefore an opaque 401 AUTHENTICATION_FAILED rather than 400
  // MISSING_NONCE — deliberately indistinguishable from a bad signature, so a
  // caller learns nothing about which check failed.
  it("rejects a missing nonce with an opaque 401", async () => {
    const body = "{}";
    await expect(verifyProviderWebhook(headersFor({ body, nonce: null }), body)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      status: 401,
    });
  });

  it("rejects a nonce containing the canonical separator", async () => {
    // A '.' in the nonce would make "<ts>.<nonce>.<body>" re-splittable, letting
    // an attacker shift bytes between fields while keeping the same digest.
    const body = "{}";
    await expect(verifyProviderWebhook(headersFor({ body, nonce: "aaa.bbb" }), body)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      status: 401,
    });
  });

  // REGRESSION GUARD (audit finding): signing the body alone made replay
  // protection decorative. An attacker who captured one valid request could
  // replay it forever with a fresh timestamp and a self-chosen nonce.
  it("rejects the pre-audit body-only signature", async () => {
    const body = JSON.stringify({ provider_transaction_id: "t1" });
    await expect(
      verifyProviderWebhook(headersFor({ body, signature: signLegacy(body) }), body),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", status: 401 });
  });

  it("rejects a captured signature re-stamped with a fresh timestamp and nonce", async () => {
    const body = JSON.stringify({ provider_transaction_id: "t1" });
    const capturedTs = String(nowSeconds());
    const capturedNonce = "captured-nonce";
    const captured = sign(capturedTs, capturedNonce, body);

    // The attacker's move: reuse the signature, refresh the replay headers.
    await expect(
      verifyProviderWebhook(
        headersFor({ body, signature: captured, timestamp: nowSeconds(), nonce: "attacker-nonce" }),
        body,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", status: 401 });

    // Sanity: the ORIGINAL pairing still verifies, so the rejection above is
    // about the binding, not a broken signer.
    await expect(
      verifyProviderWebhook(
        headersFor({ body, signature: captured, timestamp: Number(capturedTs), nonce: capturedNonce }),
        body,
      ),
    ).resolves.toMatchObject({ providerCode: PROVIDER });
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
