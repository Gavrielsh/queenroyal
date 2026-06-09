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

  /** Bind address. `0.0.0.0` inside a container; override to `127.0.0.1` for local-only. */
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65535).default(8080),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

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
});

export type Env = Readonly<z.infer<typeof envSchema>>;

let cached: Env | null = null;

/**
 * Parse and cache `process.env` exactly once. Throws (fail closed) on any invalid/missing
 * variable, with a precise, secret-free message naming the offending keys.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  cached = Object.freeze(parsed.data);
  return cached;
}

/** Test-support: drop the memoized env so a suite can re-parse with a fresh process.env. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
