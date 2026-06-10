import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Stub the Prisma singleton so the VALID-token path (which reaches the DB) can run without a
// live database. The auth boundary itself executes in the preHandler before any DB access.
vi.mock("../src/lib/prisma", () => ({
  getPrisma: () => ({
    engineRequestLog: {
      count: async () => 0,
      findMany: async () => [],
    },
  }),
}));

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";
import { signAdminToken } from "../src/lib/jwt";

const ADMIN_SECRET = "test-admin-jwt-secret-0123456789";

/** Authorization header carrying `token`. */
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Task — DLQ admin API, JWT-hardened. These exercise the SECURITY BOUNDARY: the surface is
 * locked (403) with no ADMIN_JWT_SECRET, rejects missing/forged/expired tokens (401), rejects
 * cryptographically-valid tokens WITHOUT the admin role (403), and admits a properly-signed
 * `role: "admin"` JWT. Replay's DB success path needs an integration DB and stays out of scope.
 */
describe("admin DLQ API — JWT auth boundary", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    delete process.env.ADMIN_JWT_SECRET;
    resetEnvCacheForTests();
    await app.close();
  });

  it("→ 403 (fail closed) when ADMIN_JWT_SECRET is not configured", async () => {
    delete process.env.ADMIN_JWT_SECRET;
    resetEnvCacheForTests();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/dlq",
      headers: bearer(jwt.sign({ sub: "ops-1", role: "admin" }, ADMIN_SECRET)),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_API_DISABLED" } });
  });

  it("→ 401 when configured but the Authorization header is missing", async () => {
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    resetEnvCacheForTests();
    const res = await app.inject({ method: "GET", url: "/api/admin/dlq" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_UNAUTHORIZED" } });
  });

  it("→ 401 when the JWT is forged (signed with the WRONG secret)", async () => {
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    resetEnvCacheForTests();
    const forged = jwt.sign({ sub: "ops-1", role: "admin" }, "not-the-admin-secret-9876543210");
    const res = await app.inject({ method: "GET", url: "/api/admin/dlq", headers: bearer(forged) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_UNAUTHORIZED" } });
  });

  it("→ 401 when the admin JWT is expired (replay route is equally guarded)", async () => {
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    resetEnvCacheForTests();
    const expired = jwt.sign({ sub: "ops-1", role: "admin" }, ADMIN_SECRET, { expiresIn: -60 });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/dlq/some-id/replay",
      headers: bearer(expired),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_UNAUTHORIZED" } });
  });

  it("→ 403 when the JWT verifies but does NOT carry role: 'admin'", async () => {
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    resetEnvCacheForTests();
    const notAdmin = jwt.sign({ sub: "user-1", role: "support" }, ADMIN_SECRET, { expiresIn: "5m" });
    const res = await app.inject({ method: "GET", url: "/api/admin/dlq", headers: bearer(notAdmin) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_FORBIDDEN" } });
  });

  it("→ 401 for a PLAYER access token (signed with JWT_SECRET, not the admin secret)", async () => {
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    resetEnvCacheForTests();
    const playerToken = jwt.sign(
      { sub: "player-1", email: "p@example.test" },
      process.env.JWT_SECRET as string,
      { expiresIn: "5m" },
    );
    const res = await app.inject({ method: "GET", url: "/api/admin/dlq", headers: bearer(playerToken) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_UNAUTHORIZED" } });
  });

  it("→ 200 with a valid admin JWT minted by signAdminToken()", async () => {
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    resetEnvCacheForTests();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/dlq",
      headers: bearer(signAdminToken({ sub: "ops-1" })),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      data: { items: [], pagination: { total: 0 } },
    });
  });
});
