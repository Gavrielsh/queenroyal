import { z } from "zod";

/**
 * Strict, fail-closed environment contract (guardrail: ZERO IMPLICIT ANY — every boundary is
 * Zod-parsed). The process refuses to boot on an invalid or missing variable rather than
 * starting in an undefined state.
 *
 * Phase 1 only needs transport + logging configuration. Later phases extend this schema as
 * routes are migrated (DATABASE_URL for Prisma, REDIS_URL for the fail-closed limiter /
 * replay store, ENGINE_BASE_URL / ENGINE_SECRET_KEY for outbound HMAC). Those are added when
 * the code that consumes them lands — never before.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ── Database (Postgres via Prisma) ──────────────────────────────────────────────
  // Runtime / pooled connection. In production this points at PgBouncer (transaction mode)
  // and MUST carry `?pgbouncer=true` so Prisma disables server-side prepared statements
  // (see src/lib/prisma.ts). Required — the gateway fails closed without it.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Direct, NON-pooled (session-mode) connection used ONLY by `prisma migrate`/introspect,
  // which cannot run through a transaction-mode pooler. The app never reads this at runtime.
  DIRECT_DATABASE_URL: z.string().min(1).optional(),

  /** Bind address. `0.0.0.0` inside a container; override to `127.0.0.1` for local-only. */
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65535).default(8080),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // ── Auth (JWT access tokens + Redis refresh sessions) ─────────────────────────────
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  // Short-lived access token lifetime (e.g. "15m", "900"). Keep this small.
  JWT_ACCESS_TTL: z.string().default("15m"),
  // Opaque refresh-token lifetime in seconds (default 7 days).
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  // Redis-backed auth rate limiting (per IP, fixed window). FAIL CLOSED: if Redis is down the
  // auth path returns 503, never a process-local fallback (Phase 4 contract).
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // ── Event-driven reconciler / Redis-Streams broker (Phase 5) ──────────────────────
  // The reconciler is a long-lived CONSUMER (no DB polling, no cron): it blocks on the
  // Redis Stream and reacts to producer events. These tune the consume loop and the DLQ.
  // Max messages claimed per consume cycle.
  RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  // How long XREADGROUP blocks for fresh events per cycle (ms).
  RECONCILE_STREAM_BLOCK_MS: z.coerce.number().int().positive().default(5_000),
  // Min idle time before an in-flight (PEL) message left by a crashed consumer is reclaimed.
  RECONCILE_RECLAIM_IDLE_MS: z.coerce.number().int().positive().default(60_000),
  // Backstop delay / still-failing retry delay (ms): a freshly-opened deposit's lost-webhook
  // backstop, and the re-schedule gap for an intent that is still failing.
  RECONCILE_STALE_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  // Per-INTENT engine-attempt budget before it is ABANDONED → DLQ.
  RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  // Per-MESSAGE redelivery budget before a poison message is dead-lettered.
  RECONCILE_MAX_DELIVERIES: z.coerce.number().int().positive().default(5),

  /**
   * Comma-separated allow-list of browser origins permitted by CORS. Empty (the default) =>
   * NO cross-origin browser access at all (same-origin / server-to-server only), which is the
   * safe default for a gateway whose callers are servers and webhooks, not browsers.
   */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /** Hard cap on request body size (bytes). Webhooks are small; a tight bound blunts abuse. */
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576), // 1 MiB

  // ── Distributed state (Redis: webhook replay nonces; rate limiting in a later phase) ──
  // REQUIRED for the webhook perimeter: replay protection fails CLOSED (HTTP 503) when it is
  // unavailable. Optional only for local single-process dev that doesn't exercise webhooks.
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL").optional(),
  REDIS_CB_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  REDIS_CB_COOLDOWN_MS: z.coerce.number().int().positive().default(10_000),

  // ── Outbound — this gateway acting as an operator of the True Engine ──
  ENGINE_BASE_URL: z.string().url("ENGINE_BASE_URL must be a valid URL"),
  ENGINE_SECRET_KEY: z.string().min(16, "ENGINE_SECRET_KEY must be at least 16 characters"),
  // Our operator code, sent as `X-Operator-Code`; selects our secret on the engine side.
  ENGINE_OPERATOR_CODE: z.string().min(1, "ENGINE_OPERATOR_CODE is required"),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Inbound — per-provider HMAC secrets for B2B game-aggregator webhooks ──
  // JSON object {"PRAGMATIC":"secret"} or CSV "PRAGMATIC:secret,HACKSAW:secret2".
  PROVIDER_WEBHOOK_SECRETS: z
    .string()
    .default("{}")
    .transform((raw, ctx): Record<string, string> => {
      const map = parseSecretsMap(raw);
      if (!map) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PROVIDER_WEBHOOK_SECRETS must be JSON {code:secret} or CSV code:secret pairs",
        });
        return z.NEVER;
      }
      return map;
    }),

  // ── Payment Service Provider (PSP) ──
  // Which provider backs the cashier. "mock" is dev/test only.
  PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Generic PSP webhook signing secret (used by the mock provider's webhook verifier).
  PSP_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

let cached: Env | null = null;

/**
 * Parse and cache `process.env` exactly once. Throws (fail closed) on any invalid/missing
 * variable, with a precise, secret-free message naming the offending keys.
 */
export function getEnv(): Env {
  if (cached) return cached;

  // Accept ENGINE_SECRET as an alias for the canonical ENGINE_SECRET_KEY.
  const raw = {
    ...process.env,
    ENGINE_SECRET_KEY: process.env.ENGINE_SECRET_KEY ?? process.env.ENGINE_SECRET,
  };

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  cached = Object.freeze(parsed.data);
  return cached;
}

/**
 * Parse the provider-secret map from JSON (`{"CODE":"secret"}`) or CSV (`CODE:secret,...`).
 * Returns `null` on a malformed value (the caller turns that into a Zod issue). An empty map
 * is valid — it simply means no inbound providers are configured and every webhook is rejected
 * as unknown.
 */
function parseSecretsMap(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "{}") return {};

  if (trimmed.startsWith("{")) {
    try {
      const obj: unknown = JSON.parse(trimmed);
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
      const out: Record<string, string> = {};
      for (const [code, secret] of Object.entries(obj)) {
        if (typeof secret !== "string" || code.trim() === "" || secret === "") return null;
        out[code] = secret;
      }
      return out;
    } catch {
      return null;
    }
  }

  const out: Record<string, string> = {};
  for (const pair of trimmed.split(",")) {
    const p = pair.trim();
    if (p === "") continue;
    const idx = p.indexOf(":");
    if (idx <= 0) return null;
    const code = p.slice(0, idx).trim();
    const secret = p.slice(idx + 1).trim();
    if (code === "" || secret === "") return null;
    out[code] = secret;
  }
  return out;
}

/** Test-support: drop the memoized env so a suite can re-parse with a fresh process.env. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
