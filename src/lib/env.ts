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
  ENGINE_BASE_URL: z.string().url("ENGINE_BASE_URL must be a valid URL"),
  ENGINE_SECRET_KEY: z.string().min(16, "ENGINE_SECRET_KEY must be at least 16 characters"),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
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
