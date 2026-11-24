import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { getEnv, resetEnvCacheForTests } from "../src/config/env";
import { verifyAccessToken } from "../src/lib/jwt";
import { resetDb } from "./fakes/prisma.fake";

/**
 * POST /api/auth/mock-login — the dev-only session bootstrap (Milestone 0.7).
 *
 * This route mints a fully-valid session for a fixed user whose kycStatus is VERIFIED, the
 * state that unlocks purchases and redemptions. It is the ONLY code path in the gateway that
 * grants VERIFIED, so anyone who can reach it can mint a KYC-passed identity with no
 * credentials.
 *
 * It was previously gated by `NODE_ENV !== "production"` in two places. Both were DENYLIST
 * checks, and env parsing defaults NODE_ENV to "development" — so an unset, non-forwarded, or
 * misspelled NODE_ENV resolved to a permissive value and the route registered itself. The
 * guard failed OPEN on exactly the misconfiguration it existed to survive.
 *
 * The gate is now two independent layers, and these tests cover both:
 *   1. BUILD — src/dev is excluded by tsconfig.build.json, so the production artifact has no
 *      such route. Asserted by scripts/verify-no-dev-routes.mjs against dist/, not here.
 *   2. RUNTIME — an ALLOWLIST (NODE_ENV exactly development|test) AND an explicit
 *      ENABLE_DEV_MOCK_LOGIN=true. Every case below.
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

  /**
   * Bring the app up with an explicit environment. `undefined` DELETES the variable rather
   * than setting it empty — the two are different failure modes, and the one that matters
   * here is genuinely-absent. (An EMPTY NODE_ENV is separately rejected by the env schema,
   * which fails the boot closed; that is asserted below.)
   */
  async function bootWith(env: Record<string, string | undefined>): Promise<FastifyInstance> {
    for (const [k, v] of Object.entries(env)) {
      vi.stubEnv(k, v as string);
    }
    resetEnvCacheForTests();
    return buildApp();
  }

  describe("enabled: NODE_ENV is on the allowlist AND the flag is set", () => {
    it("issues a verifiable access token for the fixed VERIFIED mock user", async () => {
      app = await bootWith({ NODE_ENV: "test", ENABLE_DEV_MOCK_LOGIN: "true" });
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
      app = await bootWith({ NODE_ENV: "test", ENABLE_DEV_MOCK_LOGIN: "true" });
      const first = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
      const second = await app.inject({ method: "POST", url: "/api/auth/mock-login" });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().data.user.id).toBe(first.json().data.user.id);
    });
  });

  describe("denied: the route is never registered", () => {
    /**
     * The regression that matters most. Before 0.7 this case REGISTERED the route: NODE_ENV
     * was absent, env parsing defaulted it to "development", and `!== "production"` passed.
     * A container spec that forgot NODE_ENV shipped a credential-free KYC-VERIFIED mint.
     */
    it("when NODE_ENV is unset — the old denylist guard failed open here", async () => {
      app = await bootWith({ NODE_ENV: undefined, ENABLE_DEV_MOCK_LOGIN: undefined });
      const res = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
      expect(res.statusCode).toBe(404);
    });

    // Two misconfigurations at once: the flag switched on AND NODE_ENV forgotten. The gate
    // reads the RAW NODE_ENV rather than the schema-defaulted one, so an absent value is not
    // silently upgraded to "development" and the route stays unregistered.
    it("when NODE_ENV is unset even if the flag IS set", async () => {
      app = await bootWith({ NODE_ENV: undefined, ENABLE_DEV_MOCK_LOGIN: "true" });
      const res = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
      expect(res.statusCode).toBe(404);
    });

    it("in development WITHOUT the explicit opt-in flag", async () => {
      app = await bootWith({ NODE_ENV: "development", ENABLE_DEV_MOCK_LOGIN: undefined });
      const res = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    });

    it("in production", async () => {
      app = await bootWith({ NODE_ENV: "production", ENABLE_DEV_MOCK_LOGIN: undefined });
      const res = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    });

    // Only the exact string "true" opts in. A truthy-looking value is not a positive signal.
    for (const value of ["", "false", "0", "yes", "1", "TRUE ", "enabled"]) {
      it(`in development with ENABLE_DEV_MOCK_LOGIN=${JSON.stringify(value)}`, async () => {
        app = await bootWith({ NODE_ENV: "development", ENABLE_DEV_MOCK_LOGIN: value });
        const res = await app.inject({ method: "POST", url: "/api/auth/mock-login" });
        // "TRUE " is trimmed and lower-cased, so it IS a valid opt-in; everything else is not.
        expect(res.statusCode).toBe(value.trim().toLowerCase() === "true" ? 200 : 404);
      });
    }
  });

  describe("malformed NODE_ENV fails closed", () => {
    // An EMPTY NODE_ENV is not the same as an absent one: zod's .default() only applies to
    // undefined, so "" reaches the enum and is rejected. The boot fails rather than falling
    // back to a permissive value — the right direction for a variable that gates this route.
    it("refuses to boot when NODE_ENV is set but empty", () => {
      vi.stubEnv("NODE_ENV", "");
      vi.stubEnv("ENABLE_DEV_MOCK_LOGIN", "true");
      resetEnvCacheForTests();

      expect(() => getEnv()).toThrow(/Invalid environment configuration/);
    });
  });

  describe("boot refusal", () => {
    /**
     * A production build does not contain the route, so the flag could simply be ignored
     * there. Ignoring it silently would leave the operator believing something untrue about
     * the process — the same expectation gap the retired HMAC kill switch created — so the
     * boot fails instead.
     */
    it("refuses to start when the flag is set with NODE_ENV=production", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_DEV_MOCK_LOGIN", "true");
      resetEnvCacheForTests();

      expect(() => getEnv()).toThrow(/REFUSING TO BOOT/);
      expect(() => getEnv()).toThrow(/ENABLE_DEV_MOCK_LOGIN/);
    });
  });
});
