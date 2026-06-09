import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";

/**
 * Task 3 — DLQ admin API. These exercise the SECURITY BOUNDARY (the placeholder admin auth) which
 * runs in the preHandler BEFORE any DB access, so they hold without a live database — mirroring
 * the repo's existing perimeter tests. The list/replay DB success paths require an integration DB
 * and are out of scope for these unit tests.
 */
describe("admin DLQ API — auth boundary", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    delete process.env.ADMIN_API_TOKEN;
    resetEnvCacheForTests();
    await app.close();
  });

  it("→ 403 (fail closed) when ADMIN_API_TOKEN is not configured", async () => {
    delete process.env.ADMIN_API_TOKEN;
    resetEnvCacheForTests();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/dlq",
      headers: { "x-admin-token": "anything" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_API_DISABLED" } });
  });

  it("→ 401 when configured but the X-Admin-Token header is missing", async () => {
    process.env.ADMIN_API_TOKEN = "s3cr3t-admin-token-0123456789";
    resetEnvCacheForTests();
    const res = await app.inject({ method: "GET", url: "/api/admin/dlq" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_UNAUTHORIZED" } });
  });

  it("→ 401 when the admin token is wrong (replay route is equally guarded)", async () => {
    process.env.ADMIN_API_TOKEN = "s3cr3t-admin-token-0123456789";
    resetEnvCacheForTests();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/dlq/some-id/replay",
      headers: { "x-admin-token": "not-the-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ADMIN_UNAUTHORIZED" } });
  });
});
