import { createHmac, timingSafeEqual } from "node:crypto";

import type { Redis } from "ioredis";

import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { getRedis } from "@/lib/redis";

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
 *   4. X-Nonce single-use (per-provider) → replay protection, REQUIRED-Redis & distributed.
 *
 * Replay protection is backed EXCLUSIVELY by Redis. There is deliberately NO in-process
 * fallback: in a multi-instance deployment a per-process Map is a split-brain replay hole
 * (a nonce burned on one node is unseen by the others). If Redis is unconfigured or
 * unreachable, every webhook is rejected with HTTP 503. Fail closed, always.
 */

const HEADER_PROVIDER = "x-provider-code";
const HEADER_SIGNATURE = "x-signature";
const HEADER_TIMESTAMP = "x-timestamp";
const HEADER_NONCE = "x-nonce";

/** Reject requests older than this (matches the engine's 300s window). */
export const MAX_AGE_SECONDS = 300;
/** Tolerance for a provider clock slightly ahead of ours. */
export const MAX_FUTURE_SKEW_SECONDS = 30;
/** Nonce lifetime — 10 minutes, exactly as the engine's ReplayGuard (SET NX EX 600). */
export const NONCE_TTL_SECONDS = 600;

const HEX_RE = /^[0-9a-fA-F]+$/;
const NONCE_KEY_PREFIX = "webhook:nonce:";

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
 * Single-use nonce store. The ONLY production implementation is Redis-backed and
 * distributed. Tests may inject a custom store via {@link setNonceStore}; there is no
 * in-process default — a missing store fails closed.
 */
export interface NonceStore {
  /** Returns true if the nonce was unseen (and is now reserved); false if a replay. */
  reserve(key: string): Promise<boolean>;
}

/** Redis-backed, distributed nonce store. `SET key 1 EX 600 NX`. */
class RedisNonceStore implements NonceStore {
  constructor(private readonly client: Redis) {}

  async reserve(key: string): Promise<boolean> {
    // "OK" => the key did not exist and is now reserved (fresh). null => replay.
    const res = await this.client.set(`${NONCE_KEY_PREFIX}${key}`, "1", "EX", NONCE_TTL_SECONDS, "NX");
    return res === "OK";
  }
}

let nonceStoreOverride: NonceStore | null = null;

/** Override the nonce store (tests, or an alternative distributed implementation). */
export function setNonceStore(store: NonceStore | null): void {
  nonceStoreOverride = store;
}

/**
 * Resolve the nonce store. Throws a 503 {@link WebhookVerificationError} when Redis is not
 * configured — there is no in-memory fallback (it would be a multi-instance replay hole).
 */
function nonceStore(): NonceStore {
  if (nonceStoreOverride) return nonceStoreOverride;
  const redis = getRedis();
  if (!redis) {
    throw new WebhookVerificationError("REPLAY_STORE_UNAVAILABLE", "replay protection unavailable", 503);
  }
  return new RedisNonceStore(redis);
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

  // Resolve the replay store FIRST — fail closed (503) before doing any work if it's down.
  const store = nonceStore();

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

  // 4. Nonce single-use (scoped per provider). FAIL CLOSED on a store error.
  if (!nonce) {
    throw new WebhookVerificationError("MISSING_NONCE", "X-Nonce header is required", 400);
  }
  let fresh: boolean;
  try {
    fresh = await store.reserve(`${providerCode}:${nonce}`);
  } catch (err) {
    log().error({ err, provider: providerCode }, "nonce store unavailable — rejecting webhook (fail closed)");
    throw new WebhookVerificationError("REPLAY_STORE_UNAVAILABLE", "replay protection unavailable", 503);
  }
  if (!fresh) {
    throw new WebhookVerificationError("REPLAY_DETECTED", "X-Nonce already used", 401);
  }

  return { providerCode, rawBody };
}
