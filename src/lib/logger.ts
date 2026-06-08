import pino, { type Logger } from "pino";

import { getEnv } from "@/lib/env";

/**
 * Structured JSON logger (Pino). `console.*` is banned in this repository — every log
 * line is machine-parseable JSON with an ISO timestamp, the level, and whatever
 * contextual metadata the call site attaches (trace_id, operator_transaction_id,
 * user_id, ...). Errors are passed under the `err` key so the std serializer preserves
 * the message, type, and full stack trace.
 *
 * Usage:
 *   log().error({ err, operator_transaction_id, user_id }, "ledger credit failed");
 *   const reqLog = childLogger({ trace_id }); reqLog.info({ user_id }, "login");
 */

/**
 * PCI-DSS / PII redaction paths (Phase 4). Secrets and PII must NEVER reach the log stream
 * — leakage is a fatal compliance violation. Path-based redaction strips the listed keys
 * (top level and one nesting level, plus common header locations). Exported so it can be
 * asserted in tests; `remove: true` deletes the key entirely rather than printing a
 * `[Redacted]` placeholder.
 */
export const REDACTION_PATHS: string[] = [
  // Credentials
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "newPassword",
  "*.newPassword",
  // Authorization headers (Bearer JWTs live here) — both casings, common nestings
  "authorization",
  "*.authorization",
  "Authorization",
  "*.Authorization",
  "headers.authorization",
  "*.headers.authorization",
  "headers.Authorization",
  "req.headers.authorization",
  "request.headers.authorization",
  // JWTs / opaque session tokens
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "token",
  "*.token",
  "jwt",
  "*.jwt",
  // Payment-method details (never log raw instruments)
  "payment_method",
  "*.payment_method",
  "paymentMethod",
  "*.paymentMethod",
  "paymentToken",
  "*.paymentToken",
  "paymentMethodToken",
  "*.paymentMethodToken",
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
  // PII — user email addresses
  "email",
  "*.email",
  "userEmail",
  "*.userEmail",
];

let instance: Logger | null = null;

export function log(): Logger {
  if (instance) return instance;
  instance = pino({
    level: getEnv().LOG_LEVEL,
    base: { service: "queenroyal-gateway" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Emit the level as its name ("error") rather than a number.
      level: (label) => ({ level: label }),
    },
    serializers: {
      // Preserve message + type + stack for anything logged under `err`.
      err: pino.stdSerializers.err,
    },
    // PCI-DSS / PII redaction — strip secrets and PII before serialization (see REDACTION_PATHS).
    redact: {
      paths: REDACTION_PATHS,
      remove: true,
    },
  });
  return instance;
}

/** A logger pre-bound with contextual fields (e.g. a per-request trace_id). */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return log().child(bindings);
}

export type { Logger };
