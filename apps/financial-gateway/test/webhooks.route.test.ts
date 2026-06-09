import { createHmac, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { setNonceStore } from "../src/lib/webhook-security";

const PROVIDER_SECRET = "test-provider-secret"; // matches test/setup.ts
const PSP_SECRET = "test-psp-secret"; // PSP_WEBHOOK_SECRET in test/setup.ts

function hmacHex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function tsNow(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("webhook routes (Fastify zero-trust perimeter)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  // Always-fresh nonce store so the spin perimeter doesn't require Redis.
  beforeEach(() => setNonceStore({ reserve: async () => true }));
  afterEach(() => setNonceStore(null));

  describe("POST /api/webhooks/provider/spin", () => {
    it("rejects a bad HMAC signature with 401 — the controller never runs", async () => {
      const body = JSON.stringify({ provider_transaction_id: "t1" });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/provider/spin",
        headers: {
          "content-type": "application/json",
          "x-provider-code": "PRAGMATIC",
          "x-signature": "deadbeef", // wrong
          "x-timestamp": tsNow(),
          "x-nonce": randomUUID(),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ success: false, error: { code: "AUTHENTICATION_FAILED" } });
    });

    it("rejects a missing nonce with 400 (perimeter, before the controller)", async () => {
      const body = JSON.stringify({ provider_transaction_id: "t1" });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/provider/spin",
        headers: {
          "content-type": "application/json",
          "x-provider-code": "PRAGMATIC",
          "x-signature": hmacHex(body, PROVIDER_SECRET),
          "x-timestamp": tsNow(),
          // no x-nonce
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ success: false, error: { code: "MISSING_NONCE" } });
    });

    it("passes the perimeter but 422s a malformed payload (valid signature)", async () => {
      const body = JSON.stringify({ not: "a valid spin" });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/provider/spin",
        headers: {
          "content-type": "application/json",
          "x-provider-code": "PRAGMATIC",
          "x-signature": hmacHex(body, PROVIDER_SECRET),
          "x-timestamp": tsNow(),
          "x-nonce": randomUUID(),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    });
  });

  describe("POST /api/webhooks/psp", () => {
    it("rejects a bad signature with 401", async () => {
      const body = JSON.stringify({ type: "payment_intent.succeeded", payment_intent_id: "pi_1", status: "succeeded" });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/psp",
        headers: { "content-type": "application/json", "stripe-signature": "deadbeef" },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ success: false, error: { code: "PSP_WEBHOOK_BAD_SIGNATURE" } });
    });

    it("verifies a valid signature and 200s an event without operator_transaction_id (no DB hit)", async () => {
      const body = JSON.stringify({
        id: "evt_1",
        type: "payment_intent.succeeded",
        payment_intent_id: "pi_1",
        amount_cents: 1000,
        currency: "USD",
        status: "succeeded",
        metadata: {}, // no operator_transaction_id → handler returns early, never touches the DB
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/psp",
        headers: { "content-type": "application/json", "stripe-signature": hmacHex(body, PSP_SECRET) },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, data: { received: true, handled: false } });
    });
  });
});
