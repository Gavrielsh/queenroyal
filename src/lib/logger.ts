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
    // Defense-in-depth: never let a secret reach the log stream.
    redact: {
      paths: [
        "password",
        "passwordHash",
        "*.password",
        "*.passwordHash",
        "accessToken",
        "refreshToken",
        "*.accessToken",
        "*.refreshToken",
        "headers.authorization",
        "*.headers.authorization",
      ],
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
