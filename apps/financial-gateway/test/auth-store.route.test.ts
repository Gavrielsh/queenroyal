import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { signAccessToken } from "../src/lib/jwt";

/**
 * Phase 6 perimeter tests for the ported auth + store routes. They exercise the SECURITY
 * BOUNDARY without a live DB/Redis — exactly the surfaces that must hold even (especially) when
 * the distributed stores are down:
 *   - the auth rate limiter FAILS CLOSED (503) when Redis is unconfigured (no in-memory bypass);
 *   - refresh-session ops FAIL CLOSED (503) when the session store is unreachable;
 *   - the cashier route REJECTS unauthenticated callers (401) before any service runs;
 *   - both routes reject malformed payloads (422) using the same Zod schemas as the legacy app.
 * The test env (test/setup.ts) deliberately sets no REDIS_URL, so getRedis() is null throughout.
 */
describe("auth + store routes (Phase 6 extraction)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/auth/register | /api/auth/login — fail-closed rate limiter", () => {
    it("register → 503 when the rate limiter (Redis) is unavailable, before any DB write", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { email: "new@player.io", password: "supersecret123" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ success: false, error: { code: "RATE_LIMITER_UNAVAILABLE" } });
    });

    it("login → 503 when the rate limiter (Redis) is unavailable", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "a@b.io", password: "whatever" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ success: false, error: { code: "RATE_LIMITER_UNAVAILABLE" } });
    });
  });

  describe("POST /api/auth/refresh", () => {
    it("→ 401 NO_REFRESH_TOKEN when the cookie is absent (no store hit)", async () => {
      const res = await app.inject({ method: "POST", url: "/api/auth/refresh" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ success: false, error: { code: "NO_REFRESH_TOKEN" } });
    });

    it("→ 503 when a cookie is present but the session store is unavailable (fail closed)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        cookies: { qr_refresh_token: "some-opaque-token" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ success: false, error: { code: "SESSION_STORE_UNAVAILABLE" } });
    });
  });

  describe("POST /api/auth/logout", () => {
    it("→ 200 and clears the cookie even when the store is down (logout never fails closed)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: { qr_refresh_token: "some-opaque-token" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, data: { loggedOut: true } });
      // The expired clearing cookie is set on the auth path.
      const setCookie = res.headers["set-cookie"];
      const header = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie);
      expect(header).toContain("qr_refresh_token=");
    });
  });

  describe("POST /api/store/purchase — auth guard runs before the controller", () => {
    it("→ 401 UNAUTHORIZED with no Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/store/purchase",
        payload: { packageId: "pkg_value_20" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    });

    it("→ 401 UNAUTHORIZED with a malformed/invalid bearer token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/store/purchase",
        headers: { authorization: "Bearer not-a-real-jwt" },
        payload: { packageId: "pkg_value_20" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    });

    it("→ 422 VALIDATION_ERROR with a valid token but a malformed body (auth passed, no DB hit)", async () => {
      const token = signAccessToken({ sub: "user-1", email: "p@q.io", kycStatus: "VERIFIED", vipLevel: 0 });
      const res = await app.inject({
        method: "POST",
        url: "/api/store/purchase",
        headers: { authorization: `Bearer ${token}` },
        payload: { notPackageId: true },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    });
  });

  describe("POST /api/store/purchase/mock-confirm — dev-only settlement stand-in", () => {
    it("→ 401 UNAUTHORIZED with no Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/store/purchase/mock-confirm",
        payload: { paymentIntentId: "pi_whatever" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    });

    it("→ 422 VALIDATION_ERROR with a valid token but a malformed body", async () => {
      const token = signAccessToken({ sub: "user-1", email: "p@q.io", kycStatus: "VERIFIED", vipLevel: 0 });
      const res = await app.inject({
        method: "POST",
        url: "/api/store/purchase/mock-confirm",
        headers: { authorization: `Bearer ${token}` },
        payload: { notAPaymentIntentId: true },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    });

    it("→ 404 INTENT_NOT_FOUND for an unknown intent id (mock provider holds no such intent)", async () => {
      const token = signAccessToken({ sub: "user-1", email: "p@q.io", kycStatus: "VERIFIED", vipLevel: 0 });
      const res = await app.inject({
        method: "POST",
        url: "/api/store/purchase/mock-confirm",
        headers: { authorization: `Bearer ${token}` },
        payload: { paymentIntentId: "pi_does_not_exist" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ success: false, error: { code: "INTENT_NOT_FOUND" } });
    });
  });
});
