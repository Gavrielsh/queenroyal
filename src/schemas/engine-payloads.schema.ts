import { z } from "zod";

import { moneyString, positiveMoneyString } from "@/lib/money";
import type {
  BetPayload,
  PurchasePayload,
  RollbackPayload,
  WinPayload,
} from "@/types/true-engine";

/**
 * STRICT runtime validation at the JSONB boundary.
 *
 * `EngineRequestLog.requestPayload` is Prisma `Json`, which surfaces in TypeScript as
 * `Prisma.JsonValue` — effectively `any`. The reconciler and the PSP webhook handler MUST
 * NOT trust that blob: a corrupted/partial row would otherwise crash a replay (or, worse,
 * forward a malformed amount to the ledger). Every payload read out of the journal is
 * therefore re-parsed through one of these Zod schemas before any replay logic runs.
 *
 * Money fields reuse the `@/lib/money` string contract (`^\d+(\.\d{1,4})?$`) — never a
 * `z.number()`. The inferred output types are structurally assignable to the engine DTOs
 * in `@/types/true-engine`, so parsed payloads forward verbatim with no `any` casts.
 */

const engineMetadata = z.record(z.unknown());

export const betPayloadSchema = z.object({
  operator_transaction_id: z.string().min(1),
  player_id: z.string().min(1),
  currency: z.enum(["GC", "SC"]),
  amount: positiveMoneyString,
  game_id: z.string().min(1).optional(),
  round_id: z.string().min(1).optional(),
  metadata: engineMetadata.optional(),
}) satisfies z.ZodType<BetPayload>;

export const winPayloadSchema = z.object({
  operator_transaction_id: z.string().min(1),
  player_id: z.string().min(1),
  currency: z.enum(["GC", "SC"]),
  amount: positiveMoneyString,
  game_id: z.string().min(1).optional(),
  round_id: z.string().min(1).optional(),
  reference_transaction_id: z.string().min(1).optional(),
  metadata: engineMetadata.optional(),
}) satisfies z.ZodType<WinPayload>;

export const rollbackPayloadSchema = z.object({
  operator_transaction_id: z.string().min(1),
  player_id: z.string().min(1),
  reference_transaction_id: z.string().min(1),
  metadata: engineMetadata.optional(),
}) satisfies z.ZodType<RollbackPayload>;

/** The ledger credit body issued once a deposit's PSP intent is confirmed `succeeded`. */
export const purchasePayloadSchema = z.object({
  operator_transaction_id: z.string().min(1),
  player_id: z.string().min(1),
  gc_amount: moneyString,
  sc_promo_amount: moneyString.optional(),
  metadata: engineMetadata.optional(),
}) satisfies z.ZodType<PurchasePayload>;

/**
 * The self-contained DEPOSIT instruction journaled at purchase time. It carries the PSP
 * intent ref (to poll/correlate), the expected amount (to defend the credit against a
 * tampered webhook), and the exact ledger body to replay on a verified `succeeded`.
 */
export const depositInstructionSchema = z.object({
  paymentIntentId: z.string().min(1),
  expectedAmountCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  purchase: purchasePayloadSchema,
});

export type DepositInstruction = z.infer<typeof depositInstructionSchema>;

/** Engine-request kinds that carry a replayable JSONB payload. */
export type ReplayableEngineRequestType = "BET" | "WIN" | "DEPOSIT" | "ROLLBACK";

export type ParsedEnginePayload =
  | { ok: true; type: "BET"; data: BetPayload }
  | { ok: true; type: "WIN"; data: WinPayload }
  | { ok: true; type: "ROLLBACK"; data: RollbackPayload }
  | { ok: true; type: "DEPOSIT"; data: DepositInstruction }
  | { ok: false; error: string };

/**
 * Parse a journal `requestPayload` against the schema for its row type. Returns a
 * discriminated success (typed, ready to replay) or a structured failure the caller turns
 * into an ABANDONED row + critical alert. NO implicit `any` escapes this boundary.
 */
export function parseEngineRequestPayload(
  type: ReplayableEngineRequestType,
  payload: unknown,
): ParsedEnginePayload {
  switch (type) {
    case "BET": {
      const r = betPayloadSchema.safeParse(payload);
      return r.success ? { ok: true, type, data: r.data } : { ok: false, error: formatIssues(r.error) };
    }
    case "WIN": {
      const r = winPayloadSchema.safeParse(payload);
      return r.success ? { ok: true, type, data: r.data } : { ok: false, error: formatIssues(r.error) };
    }
    case "ROLLBACK": {
      const r = rollbackPayloadSchema.safeParse(payload);
      return r.success ? { ok: true, type, data: r.data } : { ok: false, error: formatIssues(r.error) };
    }
    case "DEPOSIT": {
      const r = depositInstructionSchema.safeParse(payload);
      return r.success ? { ok: true, type, data: r.data } : { ok: false, error: formatIssues(r.error) };
    }
    default: {
      // Exhaustiveness guard: a new replayable type must extend this switch.
      const _never: never = type;
      return { ok: false, error: `unsupported payload type ${String(_never)}` };
    }
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
