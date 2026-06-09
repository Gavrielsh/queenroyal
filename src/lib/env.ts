import { z } from "zod";

/**
 * Server-side environment contract. Validated lazily on first access (so a missing
 * secret throws a clear error at request time rather than producing silent `undefined`
 * behaviour, without breaking `next build` when envs are not present).
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // ── Auth ──────────────────────────────────────────────────────────────────
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  // Short-lived access token lifetime (e.g. "15m", "900"). Keep this small.
  JWT_ACCESS_TTL: z.string().default("15m"),
  // Opaque refresh token lifetime in seconds (default 7 days).
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  // Redis-backed auth rate limiting (per IP, fixed window). FAIL CLOSED: if Redis is down the
  // auth path returns 503, never a process-local fallback (Phase 4).
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // ── Observability ─────────────────────────────────────────────────────────
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  // ── Distributed state (replay nonces, rate limiting, refresh sessions) ──────
  // REQUIRED in production: replay protection, rate limiting, and refresh sessions all
  // fail CLOSED (HTTP 503) when it is unavailable. Optional only for local single-process
  // dev that does not exercise those paths.
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL").optional(),

  // ── Redis circuit breaker (graceful degradation) ────────────────────────────
  // Consecutive Redis failures that trip the shared breaker open, and how long it stays
  // open (failing fast) before a half-open trial. Keeps a dead Redis from stalling routes.
  REDIS_CB_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  REDIS_CB_COOLDOWN_MS: z.coerce.number().int().positive().default(10_000),

  // Shared secret authenticating the internal reconciliation cron endpoint. When unset
  // the endpoint is disabled (503) so it can never run unauthenticated.
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters").optional(),

  // ── Reconciliation worker / cron thresholds (operational overrides) ─────────
  RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  RECONCILE_STALE_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

  // ── Payment Service Provider (PSP) ──────────────────────────────────────────
  // Which provider implementation backs the cashier. "mock" is dev/test only.
  PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
  // Real Stripe wiring (required when PAYMENT_PROVIDER=stripe).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Generic PSP webhook signing secret (used by the mock provider's webhook verifier).
  PSP_WEBHOOK_SECRET: z.string().optional(),

  // ── Outbound — this gateway acting as an operator of the True Engine ─────────
  ENGINE_BASE_URL: z.string().url("ENGINE_BASE_URL must be a valid URL"),
  ENGINE_SECRET_KEY: z.string().min(16, "ENGINE_SECRET_KEY must be at least 16 characters"),
  // Our operator code, sent as `X-Operator-Code`; selects our secret on the engine side.
  ENGINE_OPERATOR_CODE: z.string().min(1, "ENGINE_OPERATOR_CODE is required"),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Inbound — per-provider HMAC secrets for B2B game-aggregator webhooks ─────
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
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  // Accept ENGINE_SECRET as an alias for the documented canonical ENGINE_SECRET_KEY.
  const raw = {
    ...process.env,
    ENGINE_SECRET_KEY: process.env.ENGINE_SECRET_KEY ?? process.env.ENGINE_SECRET,
  };

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`[env] Invalid environment configuration: ${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/**
 * Parse the provider-secret map from JSON or CSV. Returns `null` on a malformed value
 * (the caller turns that into a Zod issue). An empty map is valid — it simply means no
 * inbound providers are configured yet, and every webhook will be rejected as unknown.
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
