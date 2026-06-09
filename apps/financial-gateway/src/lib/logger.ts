import pino, { type Logger, type LoggerOptions } from "pino";

import { getEnv } from "../config/env";

/**
 * PCI-DSS / PII redaction paths. Secrets, credentials, payment instruments, and PII must
 * NEVER reach the log stream — leakage is a fatal compliance violation. `remove: true`
 * deletes the matched key entirely rather than emitting a "[Redacted]" placeholder.
 *
 * This mirrors the redaction contract already enforced by the Next.js app's logger so the two
 * stay consistent while routes migrate across. The `*.` variants catch one level of nesting
 * (e.g. a key buried inside a logged request/payload object); `req.headers.*` covers Fastify's
 * request-log shape.
 */
export const REDACTION_PATHS: readonly string[] = [
  // ── Credentials ──────────────────────────────────────────────────────────────
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "newPassword",
  "*.newPassword",

  // ── Authorization headers (Bearer JWTs live here) — both casings & common nestings ──
  "authorization",
  "*.authorization",
  "Authorization",
  "*.Authorization",
  "headers.authorization",
  "*.headers.authorization",
  "req.headers.authorization",
  "request.headers.authorization",

  // ── Tokens / opaque sessions ─────────────────────────────────────────────────
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "token",
  "*.token",
  "jwt",
  "*.jwt",

  // ── Payment instruments — never log raw card data ────────────────────────────
  "payment_method",
  "*.payment_method",
  "paymentMethod",
  "*.paymentMethod",
  "paymentToken",
  "*.paymentToken",
  "card",
  "*.card",
  "cardNumber",
  "*.cardNumber",
  "cvv",
  "*.cvv",
  "clientSecret",
  "*.clientSecret",
  "client_secret",
  "*.client_secret",

  // ── PII ──────────────────────────────────────────────────────────────────────
  "email",
  "*.email",
  "userEmail",
  "*.userEmail",
];

/**
 * Build the Pino logger options consumed by Fastify: a fixed service name, ISO-8601
 * timestamps, the level rendered as its name (`"info"`, not `30`), and the redaction policy
 * above. Returned as plain options so Fastify owns the single logger instance.
 */
export function buildLoggerOptions(): LoggerOptions {
  return {
    level: getEnv().LOG_LEVEL,
    base: { service: "financial-gateway" },
    // ISO-8601 timestamps (equivalent to pino.stdTimeFunctions.isoTime) with no runtime
    // value-import of pino — the fragment must begin with a comma per pino's contract.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    redact: {
      paths: [...REDACTION_PATHS],
      remove: true,
    },
  };
}

let instance: Logger | null = null;

/**
 * Process-wide structured logger for services and libs (same options Fastify builds its
 * request logger from, so service logs and request logs are identically shaped & redacted).
 */
export function log(): Logger {
  if (instance) return instance;
  instance = pino(buildLoggerOptions());
  return instance;
}

/** A logger pre-bound with contextual fields (e.g. a per-request trace_id). */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return log().child(bindings);
}

export type { Logger };
