import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { resetEnvCacheForTests } from "../src/config/env";
import { signAccessToken } from "../src/lib/jwt";
import { MockKycProvider, setKycProvider } from "../src/lib/kyc";
import { handleKycDecisionEvent } from "../src/services/kyc-webhook.service";
import { requestDocumentUpload } from "../src/services/kyc.service";
import { type Directive, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import {
  getKycDocuments,
  getKycVerifications,
  getKycWebhookEvents,
  resetDb,
  seedUser,
} from "./fakes/prisma.fake";

/**
 * C3 — the KYC provider seam, document upload, and decision webhook.
 *
 * Three things have to be true and are not obvious from reading the code:
 *
 *   - the document bytes cannot reach this service or its database, even when a client tries;
 *   - a webhook signature is actually checked, in a way a forged or replayed request fails;
 *   - a redelivered decision — the normal case with every real vendor — is absorbed exactly
 *     once, including when two redeliveries race.
 */

const JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const KYC_SECRET = "test-kyc-webhook-secret-0123";
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";

const unexpected: Directive = { ok: false, status: 500, body: { code: "UNEXPECTED" } };

/** The default True Engine response to a relayed approval: applied, as a fresh decision would be. */
function approvedByEngine(call: { body: unknown }): Directive {
  const body = call.body as { external_id: string; event_id: string; decision: string };
  return {
    ok: true,
    status: 200,
    body: { code: "OK", result: { player_id: body.external_id, event_id: body.event_id, decision: body.decision, applied: true } },
  };
}

const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let app: FastifyInstance;
let redis: Redis;
let available = false;
let provider: MockKycProvider;

function bearer(userId = USER_ID): string {
  return `Bearer ${signAccessToken({ sub: userId, email: "kyc@example.test", kycStatus: "PENDING", vipLevel: 0 })}`;
}

const claims = (userId = USER_ID) => ({
  sub: userId,
  email: "kyc@example.test",
  kycStatus: "PENDING",
  vipLevel: 0,
});

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.KYC_WEBHOOK_SECRET = KYC_SECRET;
  // Lift the app-wide COARSE per-IP DoS guard for this file only.
  //
  // Not a workaround for a real limit: that guard is a blanket 100/minute across every route,
  // it is already covered by rate-limit.route.test.ts, and every request in this file comes
  // from the same synthetic address. Leaving it in place makes this suite fail once its own
  // request count crosses 100 — a failure that says nothing about KYC, appears only as the
  // file grows, and reads as a signature or idempotency bug. The KYC-specific limiter is NOT
  // lifted; it is asserted explicitly below.
  process.env.RATE_LIMIT_MAX = "100000";

  // Probe Redis BEFORE building the app: the upload limiter is fail-closed, so without a
  // reachable Redis every route test would 503 — a green suite proving the limiter refuses
  // everything rather than that it admits a genuine applicant.
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await redis.connect();
    await redis.ping();
    available = true;
  } catch (err) {
    if (process.env.REDIS_TEST_URL) {
      throw new Error(`REDIS_TEST_URL=${process.env.REDIS_TEST_URL} is set but unreachable: ${String(err)}`);
    }
    available = false;
  }
  if (available) process.env.REDIS_URL = REDIS_URL;
  resetEnvCacheForTests();

  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  setKycProvider(null);
  delete process.env.JWT_SECRET;
  delete process.env.KYC_WEBHOOK_SECRET;
  delete process.env.REDIS_URL;
  delete process.env.RATE_LIMIT_MAX;
  resetEnvCacheForTests();
  await app.close();
  if (redis) await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  resetDb();
  resetEngine();
  setEngineHandler((call) => (call.path === "/api/v1/kyc/decision" ? approvedByEngine(call) : unexpected));
  provider = new MockKycProvider(KYC_SECRET);
  setKycProvider(provider);
  seedUser({ id: USER_ID, email: "kyc@example.test", kycStatus: "PENDING", trueEnginePlayerId: "engine-kyc" });
  seedUser({ id: OTHER_USER_ID, email: "other-kyc@example.test", kycStatus: "PENDING", trueEnginePlayerId: "engine-kyc-2" });
  if (available) {
    const keys = await redis.keys("ratelimit:kyc:upload:*");
    if (keys.length > 0) await redis.del(...keys);
  }
});

afterEach(() => {
  setKycProvider(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The provider interface
// ─────────────────────────────────────────────────────────────────────────────

describe("the KycProvider seam", () => {
  it("opens a case and reuses the open one rather than starting a second", async () => {
    const first = await provider.createCase(USER_ID);
    const second = await provider.createCase(USER_ID);

    expect(first.caseRef).toBe(second.caseRef);
    expect(first.status).toBe("PENDING");
    // Two concurrent cases for one person produce two decisions that can disagree, with no
    // principled way to pick a winner afterwards.
  });

  it("gives different subjects different cases", async () => {
    const a = await provider.createCase(USER_ID);
    const b = await provider.createCase(OTHER_USER_ID);
    expect(a.caseRef).not.toBe(b.caseRef);
  });

  it("issues an expiring presigned URL and never asks for the file", async () => {
    const kase = await provider.createCase(USER_ID);
    const ticket = await provider.createDocumentUpload({
      userRef: USER_ID,
      caseRef: kase.caseRef,
      documentType: "PASSPORT",
      contentType: "image/jpeg",
    });

    expect(ticket.uploadUrl).toMatch(/^https:\/\//);
    expect(ticket.method).toBe("PUT");
    expect(ticket.headers["Content-Type"]).toBe("image/jpeg");
    // An upload URL that never expires is a permanent write handle to an identity-document
    // store, sitting in whatever log, proxy or browser history saw it.
    expect(ticket.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(ticket.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it("refuses a ticket against another subject's case", async () => {
    const kase = await provider.createCase(USER_ID);
    await expect(
      provider.createDocumentUpload({
        userRef: OTHER_USER_ID,
        caseRef: kase.caseRef,
        documentType: "PASSPORT",
        contentType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ code: "KYC_CASE_SUBJECT_MISMATCH" });
  });

  it("refuses a ticket for an unknown case", async () => {
    await expect(
      provider.createDocumentUpload({
        userRef: USER_ID,
        caseRef: "kyc_case_does_not_exist",
        documentType: "PASSPORT",
        contentType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ code: "KYC_CASE_NOT_FOUND" });
  });

  it("reads back a case the provider knows and null for one it does not", async () => {
    const kase = await provider.createCase(USER_ID);
    expect(await provider.retrieveCase(kase.caseRef)).toMatchObject({ caseRef: kase.caseRef, status: "PENDING" });
    expect(await provider.retrieveCase("kyc_case_nope")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

describe("webhook signature validation", () => {
  it("accepts a correctly signed body", async () => {
    const kase = await provider.createCase(USER_ID);
    const { rawBody, signature } = provider.buildSignedWebhook(kase.caseRef, "APPROVED");

    const event = provider.parseWebhook(rawBody, signature);
    expect(event.caseRef).toBe(kase.caseRef);
    expect(event.status).toBe("APPROVED");
  });

  it("rejects a missing, malformed, or wrong signature", async () => {
    const kase = await provider.createCase(USER_ID);
    const { rawBody, signature } = provider.buildSignedWebhook(kase.caseRef, "APPROVED");

    for (const bad of ["", "not-hex", "abc", signature.slice(0, -2), `${signature}00`, "0".repeat(64)]) {
      expect(() => provider.parseWebhook(rawBody, bad)).toThrowError(/invalid KYC webhook signature/);
    }
  });

  /**
   * THE ATTACK THIS SEAM EXISTS FOR: flipping a decision after it was signed. A signature over
   * the raw body is what makes "APPROVED" unforgeable; without it, anyone who can reach the
   * endpoint can verify themselves.
   */
  it("rejects a body tampered with after signing", async () => {
    const kase = await provider.createCase(USER_ID);
    const { rawBody, signature } = provider.buildSignedWebhook(kase.caseRef, "REJECTED");

    const tampered = rawBody.replace('"status":"REJECTED"', '"status":"APPROVED"');
    expect(tampered).not.toBe(rawBody);
    expect(() => provider.parseWebhook(tampered, signature)).toThrowError(/invalid KYC webhook signature/);
  });

  /**
   * A signature signs bytes, not meaning. A valid signature over a payload naming a DIFFERENT
   * subject is the one shape that could verify the wrong person, so the service must check the
   * subject too — see the idempotency suite's mismatch test.
   */
  it("verifies a signature over a payload whose fields are unexpected, leaving meaning to the service", async () => {
    const weird = JSON.stringify({ id: "evt-1", status: "NOT_A_STATUS", case_ref: "c", user_ref: "u" });
    const event = provider.parseWebhook(weird, provider.sign(weird));
    // An unrecognized status must never default to APPROVED — a garbled decision leaves the
    // player exactly where they were.
    expect(event.status).toBe("PENDING");
  });

  it("rejects a validly-signed body that is not JSON", async () => {
    const notJson = "this is not json";
    expect(() => provider.parseWebhook(notJson, provider.sign(notJson))).toThrowError(
      /not valid JSON/,
    );
  });

  it("refuses an unsigned request at the route, before any handling", async () => {
    const kase = await provider.createCase(USER_ID);
    const { rawBody } = provider.buildSignedWebhook(kase.caseRef, "APPROVED");

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json" },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("KYC_WEBHOOK_BAD_SIGNATURE");
    // Nothing was recorded: an unverified request must not even reach the idempotency ledger.
    expect(getKycWebhookEvents()).toHaveLength(0);
    expect(getKycVerifications().every((v) => v.status === "PENDING")).toBe(true);
  });

  it("accepts a correctly signed request at the route", async () => {
    await requestDocumentUpload(claims(), { documentType: "PASSPORT", contentType: "image/jpeg" });
    const caseRef = getKycVerifications()[0]!.providerCaseRef as string;
    const { rawBody, signature } = provider.buildSignedWebhook(caseRef, "APPROVED", { userRef: USER_ID });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": signature },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ received: true, handled: true, outcome: "approved" });
  });

  it("does not reveal WHY a signature failed", async () => {
    const kase = await provider.createCase(USER_ID);
    const { rawBody } = provider.buildSignedWebhook(kase.caseRef, "APPROVED");

    const bodies = new Set<string>();
    for (const bad of ["not-hex", "abc", "0".repeat(64), "0".repeat(62)]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/kyc",
        headers: { "content-type": "application/json", "x-kyc-signature": bad },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(401);
      bodies.add(res.body);
    }
    // One indistinguishable answer. A verifier that says which check failed is an oracle that
    // helps an attacker converge on a valid signature.
    expect(bodies.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Strict idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("webhook idempotency", () => {
  async function openCase(): Promise<string> {
    await requestDocumentUpload(claims(), { documentType: "PASSPORT", contentType: "image/jpeg" });
    return getKycVerifications()[0]!.providerCaseRef as string;
  }

  it("applies a decision once and absorbs the redelivery", async () => {
    const caseRef = await openCase();
    const { rawBody, signature, eventId } = provider.buildSignedWebhook(caseRef, "APPROVED", { userRef: USER_ID });

    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/webhooks/kyc",
        headers: { "content-type": "application/json", "x-kyc-signature": signature },
        payload: rawBody,
      });

    const first = await send();
    const second = await send();
    const third = await send();

    expect(first.json().data).toMatchObject({ handled: true, outcome: "approved" });
    // Redeliveries are absorbed, still 200 so the provider stops retrying, and report the
    // ORIGINAL outcome rather than pretending to have acted again.
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ handled: false, outcome: "approved" });
    expect(third.json().data).toMatchObject({ handled: false, outcome: "approved" });

    // ONE row in the idempotency ledger, for the one event id.
    const events = getKycWebhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.providerEventId).toBe(eventId);
  });

  /**
   * THE RACE THE UNIQUE INDEX EXISTS FOR.
   *
   * Driven at the SERVICE, not through app.inject. That is deliberate and was learned the hard
   * way: the HTTP layer serializes concurrent injects enough that a read-then-write
   * implementation ALSO passed when this was written against the route. A test that a broken
   * implementation passes is worse than no test, so this calls the function directly, where
   * the awaits genuinely interleave.
   *
   * With a "has this event been seen?" read followed by a write, every caller reads null
   * before any of them writes, and they all proceed to apply. Only claiming the event id with
   * an INSERT — whose unique the database arbitrates — leaves exactly one winner.
   */
  it("absorbs concurrent redeliveries of the same event exactly once", async () => {
    const caseRef = await openCase();
    const { rawBody, signature } = provider.buildSignedWebhook(caseRef, "APPROVED", { userRef: USER_ID });
    const event = provider.parseWebhook(rawBody, signature);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => handleKycDecisionEvent(event)),
    );

    const applied = results.filter((r) => r.handled);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.outcome).toBe("approved");
    // Seven absorbed, and exactly one row in the idempotency ledger.
    expect(results.filter((r) => !r.handled)).toHaveLength(7);
    expect(getKycWebhookEvents()).toHaveLength(1);
  });

  /**
   * The same race at the ROUTE, kept alongside the service-level test rather than instead of
   * it. It proves the wiring end to end; the one above proves the barrier.
   */
  it("absorbs concurrent redeliveries arriving over HTTP", async () => {
    const caseRef = await openCase();
    const { rawBody, signature } = provider.buildSignedWebhook(caseRef, "APPROVED", { userRef: USER_ID });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "POST",
          url: "/api/webhooks/kyc",
          headers: { "content-type": "application/json", "x-kyc-signature": signature },
          payload: rawBody,
        }),
      ),
    );

    for (const r of results) expect(r.statusCode).toBe(200);
    expect(results.filter((r) => r.json().data.handled === true)).toHaveLength(1);
    expect(getKycWebhookEvents()).toHaveLength(1);
  });

  /**
   * A LATER, DIFFERENT decision is a real event, not a duplicate. Swallowing it because the
   * case already has a status would hide a provider reversing itself — which an operator and a
   * regulator both need to see.
   */
  it("applies a later rejection that reverses an earlier approval", async () => {
    const caseRef = await openCase();

    // Explicit, ordered decidedAt: two decisions built back-to-back must not land in the
    // same millisecond, or C4's out-of-order guard would (correctly) treat the second as
    // stale rather than as the reversal this test means to exercise.
    const approve = provider.buildSignedWebhook(caseRef, "APPROVED", {
      userRef: USER_ID,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": approve.signature },
      payload: approve.rawBody,
    });

    const reject = provider.buildSignedWebhook(caseRef, "REJECTED", {
      userRef: USER_ID,
      reason: "document expired",
      decidedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": reject.signature },
      payload: reject.rawBody,
    });

    expect(res.json().data).toMatchObject({ handled: true, outcome: "rejected" });
    expect(getKycVerifications()[0]!.status).toBe("REJECTED");
    expect(getKycVerifications()[0]!.decisionReason).toBe("document expired");
    // Two distinct events, both recorded — the audit trail shows the reversal.
    expect(getKycWebhookEvents()).toHaveLength(2);
  });

  it("records but does not apply a decision for a case it never opened", async () => {
    const orphan = await provider.createCase("someone-else-entirely");
    const { rawBody, signature } = provider.buildSignedWebhook(orphan.caseRef, "APPROVED");

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": signature },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ handled: false, outcome: "unknown_case" });
    // Recorded for the trail; nothing verified.
    expect(getKycWebhookEvents()).toHaveLength(1);
    expect(getKycVerifications()).toHaveLength(0);
  });

  /**
   * A signature proves the provider sent it — NOT that it is about who it claims. A validly
   * signed event naming a different subject is the one shape that could verify the wrong
   * person, so it is recorded and refused.
   */
  it("refuses a validly-signed decision whose subject is not the case owner", async () => {
    const caseRef = await openCase();
    const { rawBody, signature } = provider.buildSignedWebhook(caseRef, "APPROVED", { userRef: OTHER_USER_ID });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": signature },
      payload: rawBody,
    });

    expect(res.json().data).toMatchObject({ handled: false, outcome: "subject_mismatch" });
    expect(getKycVerifications()[0]!.status).toBe("PENDING");
  });

  it("refuses an event with no provider event id, because it cannot be de-duplicated", async () => {
    const outcome = await handleKycDecisionEvent({
      id: "",
      type: "verification.approved",
      caseRef: "kyc_case_x",
      userRef: USER_ID,
      status: "APPROVED",
    });

    expect(outcome).toMatchObject({ handled: false, outcome: "missing_event_id" });
    expect(getKycWebhookEvents()).toHaveLength(0);
  });

  it("records a non-terminal event without changing anything", async () => {
    const caseRef = await openCase();
    const { rawBody, signature } = provider.buildSignedWebhook(caseRef, "PENDING", { userRef: USER_ID });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": signature },
      payload: rawBody,
    });

    expect(res.json().data).toMatchObject({ handled: false, outcome: "non_terminal" });
    expect(getKycVerifications()[0]!.status).toBe("PENDING");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The document upload route — and the bytes that must never arrive
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/kyc/documents", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kyc/documents",
      payload: { documentType: "PASSPORT", contentType: "image/jpeg" },
    });
    expect(res.statusCode).toBe(401);
    expect(getKycDocuments()).toHaveLength(0);
  });

  it("returns a presigned URL and records only metadata", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/kyc/documents",
      headers: { authorization: bearer() },
      payload: { documentType: "PASSPORT", contentType: "image/jpeg" },
    });

    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.uploadUrl).toMatch(/^https:\/\//);
    expect(data.method).toBe("PUT");
    expect(data.documentType).toBe("PASSPORT");

    const docs = getKycDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.providerUploadRef).toBe(data.uploadRef);
  });

  /**
   * THE CENTRAL GUARANTEE OF THIS TASK.
   *
   * A client that tries to POST the document itself is REFUSED, not silently stripped. Being
   * stripped would be the worst outcome available: the request would succeed, the applicant
   * would believe they had uploaded, and they would wait for a decision on a file nobody has.
   */
  it("refuses a body carrying document bytes instead of silently dropping them", async () => {
    if (!available) return;
    const fakePassport = Buffer.from("not really a passport, but shaped like one").toString("base64");

    for (const extra of [
      { file: fakePassport },
      { content: fakePassport },
      { data: fakePassport },
      { base64: fakePassport },
      { documentImage: `data:image/jpeg;base64,${fakePassport}` },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/kyc/documents",
        headers: { authorization: bearer() },
        payload: { documentType: "PASSPORT", contentType: "image/jpeg", ...extra },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      // The refusal names the offending KEY and never echoes its value — a base64 document in
      // an error body is an identity document in a log aggregator.
      expect(res.body).not.toContain(fakePassport);
    }

    expect(getKycDocuments()).toHaveLength(0);
  });

  /**
   * The other half of the same guarantee, checked at the DATABASE rather than the wire: no
   * stored row carries anything file-shaped, whatever a caller sent.
   */
  it("stores no field on the document row that could be a file", async () => {
    if (!available) return;
    await requestDocumentUpload(claims(), { documentType: "PASSPORT", contentType: "image/jpeg" });

    const row = getKycDocuments()[0]!;
    for (const forbidden of ["file", "content", "data", "base64", "bytes", "image", "blob"]) {
      expect(Object.keys(row).map((k) => k.toLowerCase())).not.toContain(forbidden);
    }
    // What IS stored: a pointer, a type, and an expiry.
    expect(row.providerUploadRef).toBeTruthy();
    expect(row.documentType).toBe("PASSPORT");
    expect(row.uploadExpiresAt).toBeInstanceOf(Date);
  });

  it("refuses an unknown document type and an unexpected content type", async () => {
    if (!available) return;
    for (const payload of [
      { documentType: "TATTOO", contentType: "image/jpeg" },
      { documentType: "PASSPORT", contentType: "application/zip" },
      { documentType: "PASSPORT" },
      { contentType: "image/jpeg" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/kyc/documents",
        headers: { authorization: bearer() },
        payload,
      });
      expect(res.statusCode).toBe(422);
    }
    expect(getKycDocuments()).toHaveLength(0);
  });

  it("attaches several documents to ONE case", async () => {
    if (!available) return;
    for (const documentType of ["PASSPORT", "SELFIE", "PROOF_OF_ADDRESS"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/kyc/documents",
        headers: { authorization: bearer() },
        payload: { documentType, contentType: "image/jpeg" },
      });
      expect(res.statusCode).toBe(201);
    }

    expect(getKycVerifications()).toHaveLength(1);
    expect(getKycDocuments()).toHaveLength(3);
  });

  it("refuses an already-verified account rather than minting a pointless write handle", async () => {
    if (!available) return;
    seedUser({ id: USER_ID, email: "kyc@example.test", kycStatus: "VERIFIED", trueEnginePlayerId: "engine-kyc" });

    const res = await app.inject({
      method: "POST",
      url: "/api/kyc/documents",
      headers: { authorization: bearer() },
      payload: { documentType: "PASSPORT", contentType: "image/jpeg" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("KYC_ALREADY_VERIFIED");
    expect(getKycDocuments()).toHaveLength(0);
  });

  it("throttles an account minting upload tickets, with Retry-After", async () => {
    if (!available) return;
    const codes: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/kyc/documents",
        headers: { authorization: bearer() },
        payload: { documentType: "SELFIE", contentType: "image/jpeg" },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.headers["retry-after"]).toBeDefined();
        expect(res.json().error.code).toBe("RATE_LIMITED");
      }
    }
    expect(codes[0]).toBe(201);
    expect(codes).toContain(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The end-to-end effect
// ─────────────────────────────────────────────────────────────────────────────

describe("the decision reaches the gate", () => {
  /**
   * The point of the whole task: a verified decision moves `User.kycStatus`, which is the
   * field assertKycAllows, the redemption policy and the AMOE policy all read. Without this
   * last hop the flow would be an elaborate audit trail attached to nothing.
   */
  it("moves the player's kycStatus on approval, and back on a later rejection", async () => {
    await requestDocumentUpload(claims(), { documentType: "PASSPORT", contentType: "image/jpeg" });
    const caseRef = getKycVerifications()[0]!.providerCaseRef as string;

    const approve = provider.buildSignedWebhook(caseRef, "APPROVED", {
      userRef: USER_ID,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await handleKycDecisionEvent(provider.parseWebhook(approve.rawBody, approve.signature));

    const { prismaFake } = await import("./fakes/prisma.fake");
    expect((await prismaFake.user.findUnique({ where: { id: USER_ID } }))!.kycStatus).toBe("VERIFIED");

    const reject = provider.buildSignedWebhook(caseRef, "REJECTED", {
      userRef: USER_ID,
      reason: "expired",
      decidedAt: new Date("2026-01-02T00:00:00Z"),
    });
    await handleKycDecisionEvent(provider.parseWebhook(reject.rawBody, reject.signature));

    expect((await prismaFake.user.findUnique({ where: { id: USER_ID } }))!.kycStatus).toBe("REJECTED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zone 1 relay (Task C4) — the approval crosses the boundary, and only the approval
// ─────────────────────────────────────────────────────────────────────────────

describe("relaying an approval to Zone 1 (C4)", () => {
  async function openCase(): Promise<string> {
    await requestDocumentUpload(claims(), { documentType: "PASSPORT", contentType: "image/jpeg" });
    return getKycVerifications()[0]!.providerCaseRef as string;
  }

  /** Sign an event whose `decided_at` is caller-chosen, for the out-of-order tests below. */
  function signedEventAt(
    caseRef: string,
    status: "APPROVED" | "REJECTED",
    decidedAt: Date,
    opts: { eventId?: string; reason?: string } = {},
  ): { rawBody: string; signature: string; eventId: string } {
    const eventId = opts.eventId ?? `kyc_evt_${decidedAt.getTime()}_${Math.random().toString(36).slice(2)}`;
    const body = {
      id: eventId,
      type: status === "APPROVED" ? "verification.approved" : "verification.rejected",
      case_ref: caseRef,
      user_ref: USER_ID,
      status,
      ...(opts.reason ? { reason: opts.reason } : {}),
      decided_at: decidedAt.toISOString(),
    };
    const rawBody = JSON.stringify(body);
    return { rawBody, signature: provider.sign(rawBody), eventId };
  }

  it("dispatches the approval to Zone 1 with only identity and decision fields — no balances", async () => {
    const caseRef = await openCase();
    const { rawBody, signature, eventId } = provider.buildSignedWebhook(caseRef, "APPROVED", { userRef: USER_ID });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": signature },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    const calls = engineCalls.filter((c) => c.path === "/api/v1/kyc/decision");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({
      external_id: USER_ID,
      event_id: eventId,
      decision: "VERIFIED",
    });
    // The No-Float Law: nothing balance-shaped travels with a KYC decision.
    for (const forbidden of ["amount", "balance", "gc", "sc", "currency", "gc_amount", "sc_amount"]) {
      expect(Object.keys(calls[0]!.body as object).map((k) => k.toLowerCase())).not.toContain(forbidden);
    }
  });

  it("does not dispatch to Zone 1 for a rejection", async () => {
    const caseRef = await openCase();
    const { rawBody, signature } = provider.buildSignedWebhook(caseRef, "REJECTED", { userRef: USER_ID, reason: "bad doc" });

    await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": signature },
      payload: rawBody,
    });

    expect(engineCalls.filter((c) => c.path === "/api/v1/kyc/decision")).toHaveLength(0);
  });

  /**
   * Out-of-order absorption: a redelivered or late-arriving decision that predates the case's
   * CURRENT decidedAt must be recorded but never relayed — relaying it would ask Zone 1 to
   * reconsider a player it has already resolved from a newer decision.
   */
  it("absorbs a stale, out-of-order approval without a second Zone 1 dispatch", async () => {
    const caseRef = await openCase();
    const newer = signedEventAt(caseRef, "APPROVED", new Date("2026-01-02T00:00:00Z"));
    const first = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": newer.signature },
      payload: newer.rawBody,
    });
    expect(first.json().data).toMatchObject({ handled: true, outcome: "approved" });
    expect(engineCalls.filter((c) => c.path === "/api/v1/kyc/decision")).toHaveLength(1);

    const stale = signedEventAt(caseRef, "APPROVED", new Date("2026-01-01T00:00:00Z"));
    const second = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": stale.signature },
      payload: stale.rawBody,
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ handled: false, outcome: "stale_superseded" });
    // Recorded for the audit trail, but the second (older) decision never reached Zone 1.
    expect(engineCalls.filter((c) => c.path === "/api/v1/kyc/decision")).toHaveLength(1);
    expect(getKycWebhookEvents()).toHaveLength(2);
    expect(getKycVerifications()[0]!.status).toBe("APPROVED");
  });

  /** An equal decidedAt is stale too — "strictly newer" is the bar, matching Zone 1's own check. */
  it("treats an equal decidedAt as stale, not as newer", async () => {
    const caseRef = await openCase();
    const at = new Date("2026-01-01T00:00:00Z");
    const first = signedEventAt(caseRef, "APPROVED", at);
    await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": first.signature },
      payload: first.rawBody,
    });

    const second = signedEventAt(caseRef, "APPROVED", at);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": second.signature },
      payload: second.rawBody,
    });

    expect(res.json().data).toMatchObject({ handled: false, outcome: "stale_superseded" });
    expect(engineCalls.filter((c) => c.path === "/api/v1/kyc/decision")).toHaveLength(1);
  });

  /**
   * A dispatch failure must surface as a failure, not a silent partial sync: the webhook event
   * is left in "received" (never reaches "approved") so the provider's redelivery is exactly
   * the recovery this depends on, and `User.kycStatus` has already moved by the time this is
   * hit — Zone 2's own state and Zone 1's are momentarily inconsistent until the retry lands,
   * which is why Zone 1 remains the final arbiter of `applied` rather than trusting Zone 2's.
   */
  it("surfaces a Zone 1 dispatch failure as a 500 and leaves the event unresolved", async () => {
    setEngineHandler(() => ({ ok: false, status: 503, body: { code: "ENGINE_UNAVAILABLE", message: "down" } }));
    const caseRef = await openCase();
    const { rawBody, signature, eventId } = provider.buildSignedWebhook(caseRef, "APPROVED", { userRef: USER_ID });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/kyc",
      headers: { "content-type": "application/json", "x-kyc-signature": signature },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(500);
    const events = getKycWebhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.providerEventId).toBe(eventId);
    expect(events[0]!.outcome).toBe("received");
  });
});
