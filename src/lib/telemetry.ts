/**
 * Zone 3 structured client telemetry.
 *
 * The browser UI ships no analytics/telemetry dependency, so this is a deliberately tiny,
 * dependency-free, structured logger. Every Zone 3 module emits NAMED events through
 * `logEvent` (never ad-hoc `console.log`) so later milestones (reconcile, realtime, cashier)
 * can be observed with a stable vocabulary and, eventually, forwarded to a real RUM sink.
 *
 * Two hard rules:
 *   1. `logEvent` MUST NEVER throw — telemetry sits inside money flows, and a logging fault
 *      must not abort a purchase, a wallet read, or a settlement.
 *   2. It is isomorphic — no `window`/`document` access — so it is safe in SSR/prerender and
 *      in the test (jsdom/node) environment.
 */

/**
 * The closed vocabulary of Zone 3 telemetry events. Literal-only by design: a typo or an
 * undeclared event is a compile error, not a silent string. Extended by later milestones.
 */
export type TelemetryEvent =
  | "wallet.query.error"
  | "wallet.invalidated"
  | "purchase.token.minted"
  | "purchase.token.reused"
  | "purchase.token.cleared"
  | "purchase.attempt.blocked"
  | "purchase.tab.broadcast";

/** Structured, JSON-serializable context for an event. No nested objects, no PII, no secrets. */
export type TelemetryFields = Record<string, string | number | boolean>;

/** The exact record shape written to the sink. `evt`/`ts` are reserved and always authoritative. */
export interface TelemetryRecord {
  evt: TelemetryEvent;
  ts: number;
}

/**
 * Fault- or money-flow-significant events that emit even in production. Everything else is
 * dev-only diagnostic detail, suppressed in production builds to keep the console clean and
 * to avoid leaking internal event names to end users.
 */
const ALWAYS_EMIT: ReadonlySet<TelemetryEvent> = new Set<TelemetryEvent>([
  "wallet.query.error",
  "purchase.attempt.blocked",
]);

/**
 * Emit a structured telemetry record. Never throws. In production, only `ALWAYS_EMIT` events
 * are written; in development/test every event is written.
 */
export function logEvent(evt: TelemetryEvent, fields?: TelemetryFields): void {
  try {
    const alwaysEmit = ALWAYS_EMIT.has(evt);
    if (!alwaysEmit && process.env.NODE_ENV === "production") return;

    // Build the reserved fields strictly typed, then spread caller fields FIRST so a field
    // literally named `evt`/`ts` can never clobber the authoritative values.
    const base: TelemetryRecord = { evt, ts: Date.now() };
    const record = { ...fields, ...base };

    const sink = alwaysEmit ? console.warn : console.info;
    sink("[qr:telemetry]", record);
  } catch {
    // Rule #1: a telemetry sink failure must never propagate into a money flow.
  }
}
