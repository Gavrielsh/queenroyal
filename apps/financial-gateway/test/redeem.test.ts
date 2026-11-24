import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pin the nonce so the signed material is reproducible. `createHmac` stays REAL — mocking the
 * primitive under test would make this file prove nothing.
 */
const FIXED_NONCE = "4f1e4f6a-9c2e-4a3b-8f5d-2c7b1e0a9d64";
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => FIXED_NONCE };
});

import { TrueEngineClient } from "../src/lib/true-engine";
import type { RedeemPayload } from "../src/types/true-engine";

// ─────────────────────────────────────────────────────────────────────────────
// THE GOLDEN VECTOR
// ─────────────────────────────────────────────────────────────────────────────
// These three constants were NOT written by hand and are not a restatement of the gateway's
// own logic. They are the output of the Go engine's real, unexported `canonicalPayload`
// (internal/api/hmac.go), executed inside package `api` against the payload below and
// HMAC-SHA256'd with FIXED_SECRET.
//
// That provenance is the whole point. A test that rebuilt the canonical string with the same
// template literal the client uses would pass for any template — including a wrong one — and
// the failure it must catch is precisely the two sides drifting apart. Comparing against
// bytes the ENGINE produced makes a drift on either side of the boundary a red test.
//
// To regenerate after an intentional protocol change, run this inside Zone 1's internal/api
// package (canonicalPayload is unexported, so it must be called from within it):
//
//   canon := canonicalPayload(FIXED_TIMESTAMP, FIXED_NONCE, []byte(body))
//   m := hmac.New(sha256.New, []byte(secret)); m.Write(canon)
//   fmt.Printf("%q\n%s\n", string(canon), hex.EncodeToString(m.Sum(nil)))
const FIXED_TIMESTAMP = "1758067200";
const FIXED_SECRET = "test-engine-secret-key-0123456789";

const REDEEM: RedeemPayload = {
  operator_transaction_id: "redeem:9f1c2d3e-4b5a-6c7d-8e9f-0a1b2c3d4e5f",
  player_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  amount: "125.5000",
};

/** The exact bytes the engine's canonicalPayload emitted for the request below. */
const ENGINE_CANONICAL =
  '1758067200.4f1e4f6a-9c2e-4a3b-8f5d-2c7b1e0a9d64.{"operator_transaction_id":"redeem:9f1c2d3e-4b5a-6c7d-8e9f-0a1b2c3d4e5f","player_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","amount":"125.5000"}';

/** HMAC-SHA256(ENGINE_CANONICAL, FIXED_SECRET), hex — as the engine computes it. */
const ENGINE_SIGNATURE = "eaf4ff329c19c01c79697700909067f921108603c6d8da1ecdb560a55f2e9b57";

// ── A fetch stub that keeps the RAW body string ──────────────────────────────
// The shared engine fake JSON.parses the body, which is exactly the byte-level detail this
// file exists to check — a re-serialized body can differ from the signed one and still parse
// equal. So this captures the string the client actually put on the wire.

interface Sent {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
}

let sent: Sent[] = [];
let response: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { code: "OK", result: { ledger_transaction_id: "ltx-redeem-1", status: "PROCESSED" } },
};

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Number(FIXED_TIMESTAMP) * 1000));
  global.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({
      url: typeof input === "string" ? input : String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      rawBody: init.body as string,
    });
    return { ok: response.ok, status: response.status, text: async () => JSON.stringify(response.body) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

function client(): TrueEngineClient {
  return new TrueEngineClient({
    baseUrl: "http://engine.test",
    secret: FIXED_SECRET,
    operatorCode: "TEST_OP",
    timeoutMs: 5_000,
  });
}

describe("sendRedeem — HMAC canonicalization", () => {
  it("signs a canonical string that is BYTE-identical to the engine's canonicalPayload", async () => {
    await client().sendRedeem(REDEEM);

    const call = sent[0];
    expect(call).toBeDefined();

    // Rebuilt from what actually went over the wire — the header values the engine will read
    // and the body bytes it will hash — not from the client's internal template.
    const onTheWire = `${call!.headers["X-Timestamp"]}.${call!.headers["X-Nonce"]}.${call!.rawBody}`;

    expect(onTheWire).toBe(ENGINE_CANONICAL);
    // "Byte-identical", asserted as bytes rather than as a string: this also catches an
    // encoding difference that compares equal after JS string normalization.
    expect(Buffer.from(onTheWire, "utf8").equals(Buffer.from(ENGINE_CANONICAL, "utf8"))).toBe(true);
  });

  it("produces the signature the engine will compute for those bytes", async () => {
    await client().sendRedeem(REDEEM);

    expect(sent[0]!.headers["X-Signature"]).toBe(ENGINE_SIGNATURE);
    // And the digest genuinely derives from the canonical string — not from the body alone,
    // which is the retired form the engine refuses outright.
    const bodyOnly = createHmac("sha256", FIXED_SECRET).update(sent[0]!.rawBody, "utf8").digest("hex");
    expect(sent[0]!.headers["X-Signature"]).not.toBe(bodyOnly);
  });

  it("signs the bytes it sends — the body is serialized exactly once", async () => {
    await client().sendRedeem(REDEEM);

    const { rawBody, headers } = sent[0]!;
    const recomputed = createHmac("sha256", FIXED_SECRET)
      .update(`${headers["X-Timestamp"]}.${headers["X-Nonce"]}.${rawBody}`, "utf8")
      .digest("hex");
    expect(headers["X-Signature"]).toBe(recomputed);
  });
});

describe("sendRedeem — zero-trust heritage", () => {
  it("carries the full four-header set, inherited from postTx", async () => {
    await client().sendRedeem(REDEEM);

    const { headers } = sent[0]!;
    expect(headers["X-Operator-Code"]).toBe("TEST_OP");
    expect(headers["X-Timestamp"]).toBe(FIXED_TIMESTAMP);
    expect(headers["X-Nonce"]).toBe(FIXED_NONCE);
    expect(headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("posts to the engine's redeem endpoint", async () => {
    await client().sendRedeem(REDEEM);
    expect(sent[0]!.url).toBe("http://engine.test/api/v1/store/redeem");
  });

  it("unwraps the { code, result } envelope like every other tx call", async () => {
    const res = await client().sendRedeem(REDEEM);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.ledger_transaction_id).toBe("ltx-redeem-1");
  });

  it("returns a typed failure rather than throwing, and marks 409/5xx retryable", async () => {
    response = { ok: false, status: 409, body: { code: "TRANSACTION_PENDING", message: "in flight" } };
    const res = await client().sendRedeem(REDEEM);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryable).toBe(true);
      expect(res.error.code).toBe("TRANSACTION_PENDING");
    }

    response = { ok: false, status: 403, body: { code: "PLAYTHROUGH_OUTSTANDING", message: "not yet" } };
    const refused = await client().sendRedeem(REDEEM);
    expect(refused.ok).toBe(false);
    // A refusal the engine is certain about is terminal: retrying cannot change the answer.
    if (!refused.ok) expect(refused.retryable).toBe(false);

    response = { ok: true, status: 200, body: { code: "OK", result: { ledger_transaction_id: "ltx-redeem-1" } } };
  });
});

describe("sendRedeem — float ban at the network boundary", () => {
  it("puts the amount on the wire as the exact decimal string it was given", async () => {
    await client().sendRedeem(REDEEM);

    // Asserted against the RAW body, because that is what the engine parses. A number would
    // serialize as 125.5 and lose the scale the ledger's NUMERIC(18,4) expects.
    expect(sent[0]!.rawBody).toContain('"amount":"125.5000"');
    expect(sent[0]!.rawBody).not.toContain('"amount":125.5');
    expect(typeof (JSON.parse(sent[0]!.rawBody) as { amount: unknown }).amount).toBe("string");
  });

  it("preserves trailing-zero scale rather than normalizing it", async () => {
    await client().sendRedeem({ ...REDEEM, amount: "10.0000" });
    expect(sent[0]!.rawBody).toContain('"amount":"10.0000"');
  });
});
