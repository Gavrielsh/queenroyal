import { createHmac, randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import type { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Back the Redis-dependent paths with the in-memory fake so rate limiting is exercised
// end to end (no real Redis). `getRedis` is a vi.fn so individual tests can simulate an
// outage by returning null.
vi.mock("@/lib/redis", async () => {
  const mod = await import("./fakes/redis.fake");
  return { getRedis: vi.fn(() => mod.redisFake) };
});

import { redisFake } from "./fakes/redis.fake";
import { __resetRedisCircuitBreaker } from "@/lib/circuit-breaker";
import { getEnv } from "@/lib/env";
import { getRedis } from "@/lib/redis";
import { requireAuth, UnauthorizedError } from "@/lib/auth-guard";
import { enforceAuthRateLimit } from "@/lib/auth-http";
import { signAccessToken, verifyAccessToken, type AuthClaims } from "@/lib/jwt";
import { REDACTION_PATHS } from "@/lib/logger";
import { __resetInMemoryBuckets, rateLimit, RateLimiterUnavailableError } from "@/lib/rate-limit";
import { CLOCK_DRIFT_TOLERANCE_MS, setNonceStore, verifyProviderWebhook } from "@/lib/webhook-security";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const JWT_SECRET = process.env.JWT_SECRET as string;

/** A minimal NextRequest stand-in exposing only the header accessor the code uses. */
function stubReq(headers: Record<string, string> = {}): Parameters<typeof requireAuth>[0] {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (k: string) => lower[k.toLowerCase()] ?? null } } as unknown as Parameters<typeof requireAuth>[0];
}

beforeEach(() => {
  redisFake.flushall();
  __resetRedisCircuitBreaker();
  __resetInMemoryBuckets();
  vi.mocked(getRedis).mockReturnValue(redisFake as unknown as Redis);
});

describe("Redis rate limiter (Phase 5.1)", () => {
  it("blocks requests once the threshold is breached", async () => {
    const key = `unit:${randomUUID()}`;

    const first = await rateLimit(key, 3, 60);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    expect((await rateLimit(key, 3, 60)).allowed).toBe(true);
    expect((await rateLimit(key, 3, 60)).allowed).toBe(true);

    const blocked = await rateLimit(key, 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("the auth guard returns HTTP 429 after the per-IP limit is exceeded", async () => {
    const max = getEnv().AUTH_RATE_LIMIT_MAX;
    const req = stubReq({ "x-forwarded-for": "203.0.113.7" });

    for (let i = 0; i < max; i++) {
      expect(await enforceAuthRateLimit(req, "login")).toBeNull();
    }

    const blocked = await enforceAuthRateLimit(req, "login");
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeTruthy();
  });

  it("financial rate limiting FAILS CLOSED when Redis is unreachable", async () => {
    vi.mocked(getRedis).mockReturnValue(null);
    await expect(rateLimit("financial:spin", 5, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it("auth rate limiting GRACEFULLY DEGRADES to an in-memory bucket when Redis is down (Phase 2)", async () => {
    vi.mocked(getRedis).mockReturnValue(null); // Redis outage
    const fallbackMax = getEnv().AUTH_DEGRADED_RATE_LIMIT_MAX;
    const req = stubReq({ "x-forwarded-for": "198.51.100.9" });

    // The gateway stays ALIVE (429 throttle, never a 503) using the strict local bucket.
    for (let i = 0; i < fallbackMax; i++) {
      expect(await enforceAuthRateLimit(req, "login")).toBeNull();
    }
    const blocked = await enforceAuthRateLimit(req, "login");
    expect(blocked?.status).toBe(429);
  });
});

describe("JWT access-token verification (Phase 5.2)", () => {
  const claims: AuthClaims = { sub: USER_ID, email: "tokens@test.io", kycStatus: "VERIFIED", vipLevel: 2 };

  it("accepts a freshly-minted, valid access token", () => {
    const token = signAccessToken(claims);
    const decoded = requireAuth(stubReq({ authorization: `Bearer ${token}` }));
    expect(decoded.sub).toBe(USER_ID);
    expect(decoded.kycStatus).toBe("VERIFIED");
  });

  it("REJECTS an expired access token", () => {
    const expired = jwt.sign(
      { ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, // expired a minute ago
      JWT_SECRET,
      { algorithm: "HS256" },
    );

    expect(() => verifyAccessToken(expired)).toThrow(/jwt expired/i);
    expect(() => requireAuth(stubReq({ authorization: `Bearer ${expired}` }))).toThrow(UnauthorizedError);
  });

  it("rejects a token signed with the wrong secret and a malformed header", () => {
    const forged = jwt.sign(claims, "an-attacker-controlled-secret", { algorithm: "HS256" });
    expect(() => requireAuth(stubReq({ authorization: `Bearer ${forged}` }))).toThrow(UnauthorizedError);
    expect(() => requireAuth(stubReq({ authorization: "Basic abc" }))).toThrow(UnauthorizedError);
    expect(() => requireAuth(stubReq({}))).toThrow(UnauthorizedError);
  });
});

describe("inbound webhook clock-drift tolerance (Phase 4)", () => {
  const PROVIDER_SECRET = "test-provider-secret"; // matches PROVIDER_WEBHOOK_SECRETS in setup

  // Bypass Redis: inject an always-fresh nonce store so only the timestamp logic is exercised.
  beforeEach(() => setNonceStore({ reserve: async () => true }));
  afterEach(() => setNonceStore(null));

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  function signedReq(timestampSeconds: number): Request {
    const body = JSON.stringify({ provider_transaction_id: "x", amount: "1" });
    const signature = createHmac("sha256", PROVIDER_SECRET).update(body, "utf8").digest("hex");
    return new Request("http://gateway/api/webhooks/provider/spin", {
      method: "POST",
      headers: {
        "x-provider-code": "PRAGMATIC",
        "x-signature": signature,
        "x-timestamp": String(timestampSeconds),
        "x-nonce": randomUUID(),
      },
      body,
    });
  }

  it("uses a symmetric tolerance of exactly 5000ms", () => {
    expect(CLOCK_DRIFT_TOLERANCE_MS).toBe(5000);
  });

  it("accepts a current timestamp and one within the 5s future drift window", async () => {
    await expect(verifyProviderWebhook(signedReq(nowSeconds()))).resolves.toMatchObject({ providerCode: "PRAGMATIC" });
    // 4s ahead — inside the ±5s drift window — must still verify.
    await expect(verifyProviderWebhook(signedReq(nowSeconds() + 4))).resolves.toMatchObject({ providerCode: "PRAGMATIC" });
  });

  it("rejects a timestamp drifting beyond the 5s future tolerance", async () => {
    await expect(verifyProviderWebhook(signedReq(nowSeconds() + 6))).rejects.toMatchObject({ code: "STALE_REQUEST" });
  });

  it("still rejects a genuinely stale timestamp (beyond the 300s window + drift)", async () => {
    await expect(verifyProviderWebhook(signedReq(nowSeconds() - 310))).rejects.toMatchObject({ code: "STALE_REQUEST" });
  });
});

describe("PCI-DSS / PII log redaction (Phase 4)", () => {
  /** Build a logger with the production redaction paths writing into a captured buffer. */
  function captureLog(): { logger: pino.Logger; read: () => string } {
    let buffer = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        buffer += chunk.toString();
        cb();
      },
    });
    const logger = pino({ redact: { paths: REDACTION_PATHS, remove: true } }, sink);
    return { logger, read: () => buffer };
  }

  it("strips secrets and PII while keeping safe diagnostic fields", () => {
    const { logger, read } = captureLog();
    logger.info(
      {
        user_id: "u-123",
        trace_id: "trace-abc",
        operator_transaction_id: "deposit:1",
        password: "hunter2hunter2",
        email: "victim@example.com",
        accessToken: "aaa.bbb.ccc",
        refreshToken: "rrrr",
        headers: { authorization: "Bearer leaked.jwt.token" },
        payment_method: { number: "4111111111111111" },
        paymentMethodToken: "pm_live_secret",
        card: { number: "4242424242424242", cvv: "123" },
        clientSecret: "pi_live_secret_xyz",
        nested: { password: "p", email: "n@e.io", token: "tok-nested" },
      },
      "compliance audit line",
    );

    const raw = read();
    const parsed = JSON.parse(raw);

    // Safe operational fields are preserved.
    expect(parsed.user_id).toBe("u-123");
    expect(parsed.trace_id).toBe("trace-abc");
    expect(parsed.operator_transaction_id).toBe("deposit:1");
    expect(parsed.msg).toBe("compliance audit line");

    // Every secret / PII key is removed from the structured output.
    expect(parsed.password).toBeUndefined();
    expect(parsed.email).toBeUndefined();
    expect(parsed.accessToken).toBeUndefined();
    expect(parsed.refreshToken).toBeUndefined();
    expect(parsed.headers.authorization).toBeUndefined();
    expect(parsed.payment_method).toBeUndefined();
    expect(parsed.paymentMethodToken).toBeUndefined();
    expect(parsed.card).toBeUndefined();
    expect(parsed.clientSecret).toBeUndefined();
    expect(parsed.nested.password).toBeUndefined();
    expect(parsed.nested.email).toBeUndefined();
    expect(parsed.nested.token).toBeUndefined();

    // Belt-and-braces: no secret VALUE appears anywhere in the raw serialized line.
    for (const secret of [
      "hunter2hunter2",
      "victim@example.com",
      "Bearer leaked.jwt.token",
      "4111111111111111",
      "pm_live_secret",
      "4242424242424242",
      "pi_live_secret_xyz",
      "tok-nested",
    ]) {
      expect(raw).not.toContain(secret);
    }
  });
});
