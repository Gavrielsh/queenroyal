import {
  createIntentIfAbsent,
  type EngineRequestKind,
  markIntentTerminal,
} from "../repositories/engine-journal.repository";

/**
 * Thin service facade over the Phase 2 intent-journal repository, preserving the call surface
 * the ported business logic uses (`beginEngineRequest` / `completeEngineRequest`). The
 * repository owns the isolation guarantees:
 *   - begin   → idempotent insert (unique key + ON CONFLICT DO NOTHING): no duplicate intent.
 *   - complete → SERIALIZABLE + SELECT FOR UPDATE transition that never regresses a settled
 *     intent.
 */

export type { EngineRequestKind };

export interface BeginEngineRequestArgs {
  operatorTransactionId: string;
  type: EngineRequestKind;
  playerId?: string;
  providerRef?: string;
  /** The exact body we are about to POST to the engine, stored for replay. */
  requestPayload?: unknown;
}

/** Record (or no-op on) a PENDING intent before the engine call. Idempotent on the key. */
export async function beginEngineRequest(args: BeginEngineRequestArgs): Promise<void> {
  await createIntentIfAbsent({
    operatorTransactionId: args.operatorTransactionId,
    type: args.type,
    playerId: args.playerId,
    providerRef: args.providerRef,
    requestPayload: args.requestPayload,
  });
}

export interface CompleteEngineRequestOpts {
  ledgerTransactionId?: string;
  /** Whether the failure is safe to retry (409/5xx/timeout). Recorded for the reconciler. */
  retryable?: boolean;
  /** Last engine error code/message, for diagnostics. */
  lastError?: string;
}

/** Mark a journaled intent terminal once the engine call resolves. */
export async function completeEngineRequest(
  operatorTransactionId: string,
  status: "SUCCEEDED" | "FAILED",
  opts: CompleteEngineRequestOpts = {},
): Promise<void> {
  await markIntentTerminal(operatorTransactionId, status, opts);
}
