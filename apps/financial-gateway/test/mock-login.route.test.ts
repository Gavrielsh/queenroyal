import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";
import { verifyAccessToken } from "../src/lib/jwt";
import { resetDb } from "./fakes/prisma.fake";

/**
 * POST /api/auth/mock-login — the dev-only session bootstrap.
 *
 * Two properties matter: in non-production it mints a REAL access token (standard signer,
 * verifiable by the standard verifier) for one stable mock user; in production the route is
 * NOT REGISTERED at all, so the surface simply does not exist there.
 */
describe("POST /api/auth/mock-login (dev-only session bootstrap)", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
    resetDb();
  });

  it("issues a verifiable access token for the fixed VERIFIED mock user", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/mock-login" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      success: true,
      data: { user: { id: "00000000-0000-0000-0000-000000000001", kycStatus: "VERIFIED" } },
    });

    // The token must verify with the SAME verifier the auth preHandlers use — no special path.
    const claims = verifyAccessToken(body.data.accessToken);
    expect(claims.sub).toBe(body.data.user.id);
    expect(claims.kycStatus).toBe("VERIFIED");
  });

  it("is idempotent: repeated logins reuse the same mock user", async () => {
    app = await buildApp();
    const first = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
    const second = await app.inject({ method: "POST", url: "/api/auth/mock-login" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.user.id).toBe(first.json().data.user.id);
  });

  it("does NOT exist in production — the route is never registered (404)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    resetEnvCacheForTests();
    app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});
