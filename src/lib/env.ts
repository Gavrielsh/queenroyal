import { z } from "zod";

/**
 * Server-side environment contract. Validated lazily on first access (so a missing
 * secret throws a clear error at request time rather than producing silent `undefined`
 * behaviour, without breaking `next build` when envs are not present).
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // Distributed state (replay-nonce store, reconciler coordination). Optional in dev;
  // REQUIRED in any multi-instance deployment so nonces are shared across nodes.
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL").optional(),

  // Outbound — this gateway acting as an operator of the True Engine.
  ENGINE_BASE_URL: z.string().url("ENGINE_BASE_URL must be a valid URL"),
  ENGINE_SECRET_KEY: z.string().min(16, "ENGINE_SECRET_KEY must be at least 16 characters"),
  // Our operator code, sent as `X-Operator-Code`; selects our secret on the engine side.
  ENGINE_OPERATOR_CODE: z.string().min(1, "ENGINE_OPERATOR_CODE is required"),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // Inbound — per-provider HMAC secrets for B2B game-aggregator webhooks.
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

  // Step 1 of the brief references `process.env.ENGINE_SECRET`, while the architecture
  // docs use `ENGINE_SECRET_KEY`. Accept either, preferring the documented canonical name.
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
