import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

/**
 * Inbound zero-trust verification for B2B game-aggregator webhooks. This is the mirror
 * image of the engine's own HMAC + ReplayGuard (internal/api/hmac.go, replay.go):
 * a player NEVER authorizes their own winnings — only a signed, fresh, non-replayed
 * request from a known provider may move the ledger.
 *
 * Order of checks (fail closed, single generic-ish surface):
 *   1. Known provider (X-Provider-Code → PROVIDER_WEBHOOK_SECRETS).
 *   2. HMAC-SHA256(rawBody, secret) == X-Signature  (constant-time, hex).
 *   3. X-Timestamp within the freshness window (reject > 300s old / far future).
 *   4. X-Nonce single-use (per-provider) → replay protection.
 */

const HEADER_PROVIDER = "x-provider-code";
const HEADER_SIGNATURE = "x-signature";
const HEADER_TIMESTAMP = "x-timestamp";
const HEADER_NONCE = "x-nonce";

/** Reject requests older than this (matches the engine's 300s window). */
export const MAX_AGE_SECONDS = 300;
/** Tolerance for a provider clock slightly ahead of ours. */
export const MAX_FUTURE_SKEW_SECONDS = 30;

const HEX_RE = /^[0-9a-fA-F]+$/;

export class WebhookVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Single-use nonce store. The default is in-memory (process-local) and is adequate for a
 * single instance; a multi-instance deployment MUST inject a shared store (Redis
 * `SET NX EX 600`) via {@link setNonceStore} so a nonce burned on one node is rejected
 * on every node — exactly as the engine does.
 */
export interface NonceStore {
  /** Returns true if the nonce was unseen (and is now reserved); false if a replay. */
  reserve(key: string): Promise<boolean>;
}

const NONCE_TTL_MS = (MAX_AGE_SECONDS + MAX_FUTURE_SKEW_SECONDS) * 1000;

class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>(); // key → expiry (ms epoch)

  async reserve(key: string): Promise<boolean> {
    const now = Date.now();
    if (this.seen.size > 50_000) this.sweep(now);
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > now) return false;
    this.seen.set(key, now + NONCE_TTL_MS);
    return true;
  }

  private sweep(now: number): void {
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
  }
}

let nonceStore: NonceStore = new InMemoryNonceStore();
export function setNonceStore(store: NonceStore): void {
  nonceStore = store;
}

export interface VerifiedWebhook {
  providerCode: string;
  /** The raw body bytes that were signed. Parse JSON from THIS, not from req again. */
  rawBody: string;
}

/**
 * Verify an inbound provider webhook. Consumes the request body (via `req.text()`), so
 * the caller must parse JSON from the returned {@link VerifiedWebhook.rawBody}.
 * Throws {@link WebhookVerificationError} (with an HTTP status) on any failure.
 */
export async function verifyProviderWebhook(req: Request): Promise<VerifiedWebhook> {
  const providerCode = req.headers.get(HEADER_PROVIDER) ?? "";
  const signature = req.headers.get(HEADER_SIGNATURE) ?? "";
  const timestampRaw = req.headers.get(HEADER_TIMESTAMP) ?? "";
  const nonce = req.headers.get(HEADER_NONCE) ?? "";

  // 1. Known provider → secret. Same opaque 401 for unknown provider and bad signature.
  const secret = getEnv().PROVIDER_WEBHOOK_SECRETS[providerCode];
  if (!providerCode || !secret) {
    throw new WebhookVerificationError("AUTHENTICATION_FAILED", "authentication failed", 401);
  }

  // Read the RAW body before any JSON parse — the signature is over these exact bytes.
  const rawBody = await req.text();

  // 2. HMAC compare (constant-time over decoded bytes).
  if (!signature || !HEX_RE.test(signature) || signature.length % 2 !== 0) {
    throw new WebhookVerificationError("AUTHENTICATION_FAILED", "authentication failed", 401);
  }
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WebhookVerificationError("AUTHENTICATION_FAILED", "authentication failed", 401);
  }

  // 3. Timestamp freshness.
  if (!timestampRaw || !/^\d+$/.test(timestampRaw)) {
    throw new WebhookVerificationError("INVALID_TIMESTAMP", "X-Timestamp must be unix seconds", 400);
  }
  const ts = Number(timestampRaw);
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - ts;
  if (age > MAX_AGE_SECONDS || age < -MAX_FUTURE_SKEW_SECONDS) {
    throw new WebhookVerificationError("STALE_REQUEST", "X-Timestamp outside acceptable window", 401);
  }

  // 4. Nonce single-use (scoped per provider).
  if (!nonce) {
    throw new WebhookVerificationError("MISSING_NONCE", "X-Nonce header is required", 400);
  }
  const fresh = await nonceStore.reserve(`${providerCode}:${nonce}`);
  if (!fresh) {
    throw new WebhookVerificationError("REPLAY_DETECTED", "X-Nonce already used", 401);
  }

  return { providerCode, rawBody };
}
