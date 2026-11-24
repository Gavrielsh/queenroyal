import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";
import { ageOn, isEligibleResidence, parseDateKey, TERMS_VERSION } from "../src/lib/registration-policy";
import { registerSchema } from "../src/schemas/auth.schema";
import { AuthError, login, register } from "../src/services/auth.service";
import { resetEngine } from "./fakes/engine.fake";
import { getUsers, resetDb } from "./fakes/prisma.fake";

/**
 * Sign-up eligibility: 18+, a served US state, and accepted terms — checked BEFORE any row is
 * written — plus the stored profile a later KYC check compares against.
 */

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";
/** 15:00Z on 2026-09-23. */
const NOW = new Date("2026-09-23T15:00:00Z");
const at = (d: Date) => ({ now: () => d });

const valid = {
  email: "new.player@example.test",
  password: "correct-horse-battery",
  dateOfBirth: "1990-04-12",
  residenceState: "NJ",
  acceptTerms: true as const,
};

let app: FastifyInstance;
let redis: Redis;
let available = false;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await redis.connect();
    await redis.ping();
    available = true;
  } catch (err) {
    if (process.env.REDIS_TEST_URL) {
      throw new Error(`REDIS_TEST_URL=${process.env.REDIS_TEST_URL} is set but unreachable: ${String(err)}`);
    }
  }
  if (available) process.env.REDIS_URL = REDIS_URL;
  resetEnvCacheForTests();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  delete process.env.REDIS_URL;
  resetEnvCacheForTests();
  await app.close();
  if (redis) await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  resetDb();
  resetEngine();
  if (available) {
    const keys = await redis.keys("ratelimit:*");
    if (keys.length > 0) await redis.del(...keys);
  }
});

describe("registration policy", () => {
  it("counts completed years on the UTC calendar date — the 18th birthday is the first eligible day", () => {
    expect(ageOn("2008-09-23", NOW)).toBe(18);
    expect(ageOn("2008-09-24", NOW)).toBe(17);
    expect(ageOn("1990-04-12", NOW)).toBe(36);
  });

  it("refuses impossible calendar dates", () => {
    expect(parseDateKey("2001-02-29")).toBeNull();
    expect(parseDateKey("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    expect(parseDateKey("1990-4-12")).toBeNull();
    expect(ageOn("1990-13-01", NOW)).toBeNull();
  });

  it("serves a US state unless BLOCKED_REGIONS names it; anything else is ineligible", () => {
    const blocked = ["US-WA", "US-ID"];
    expect(isEligibleResidence("NJ", blocked)).toBe(true);
    expect(isEligibleResidence("dc", blocked)).toBe(true);
    expect(isEligibleResidence("WA", blocked)).toBe(false);
    expect(isEligibleResidence("PR", blocked)).toBe(false);
    expect(isEligibleResidence("XX", blocked)).toBe(false);
  });
});

describe("registerSchema", () => {
  it("accepts a complete sign-up and normalizes email and state", () => {
    const parsed = registerSchema.parse({ ...valid, email: "  New.Player@Example.TEST ", residenceState: "nj" });
    expect(parsed.email).toBe("new.player@example.test");
    expect(parsed.residenceState).toBe("NJ");
  });

  it.each([
    ["terms not accepted", { acceptTerms: false }],
    ["terms missing", { acceptTerms: undefined }],
    ["date of birth missing", { dateOfBirth: undefined }],
    ["date of birth malformed", { dateOfBirth: "12/04/1990" }],
    ["date of birth impossible", { dateOfBirth: "1990-02-30" }],
    ["state not a US state", { residenceState: "ON" }],
    ["password too short", { password: "short" }],
  ])("refuses: %s", (_label, patch) => {
    expect(registerSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("register()", () => {
  it("creates the account with the declared profile and the accepted terms version", async () => {
    const result = await register(registerSchema.parse(valid), at(NOW));

    expect(result.user).toMatchObject({ email: valid.email, kycStatus: "PENDING" });
    expect(result.accessToken).toEqual(expect.any(String));
    const [row] = getUsers();
    expect(row).toMatchObject({ residenceState: "NJ", termsVersion: TERMS_VERSION, termsAcceptedAt: NOW });
    expect((row!.dateOfBirth as Date).toISOString()).toBe("1990-04-12T00:00:00.000Z");
    expect(row!.passwordHash).not.toBe(valid.password);
  });

  it("refuses a player under 18 — the day before the 18th birthday — and writes nothing", async () => {
    const err = await register(registerSchema.parse({ ...valid, dateOfBirth: "2008-09-24" }), at(NOW)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: "UNDERAGE", status: 403 });
    expect(getUsers()).toHaveLength(0);
  });

  it("refuses residence in a blocked state and writes nothing", async () => {
    const err = await register(registerSchema.parse({ ...valid, residenceState: "WA" }), at(NOW)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "STATE_NOT_ELIGIBLE", status: 403 });
    expect(getUsers()).toHaveLength(0);
  });

  it("refuses a second account for the same email, including a racing one (unique index → 409)", async () => {
    const input = registerSchema.parse(valid);
    const results = await Promise.allSettled([register(input, at(NOW)), register(input, at(NOW))]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "EMAIL_TAKEN", status: 409 });
    expect(getUsers()).toHaveLength(1);
  });

  it("the new account can log in with its password, and not with another", async () => {
    await register(registerSchema.parse(valid), at(NOW));
    await expect(login({ email: valid.email, password: valid.password })).resolves.toMatchObject({
      user: { email: valid.email },
    });
    await expect(login({ email: valid.email, password: "not-the-password" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
  });
});

describe("POST /api/auth/register (through the rate limiter)", () => {
  it("201 with a session and an HttpOnly refresh cookie scoped to /api/auth", async () => {
    if (!available) return;
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: valid });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, data: { user: { email: valid.email } } });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("qr_refresh_token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/auth");
  });

  it("422 VALIDATION_ERROR when the terms were not accepted", async () => {
    if (!available) return;
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...valid, acceptTerms: false } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(getUsers()).toHaveLength(0);
  });

  it("403 UNDERAGE for a date of birth less than 18 years ago", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...valid, dateOfBirth: `${new Date().getUTCFullYear() - 10}-01-01` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: "UNDERAGE" } });
  });
});
