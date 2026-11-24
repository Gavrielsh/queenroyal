import { z } from "zod";

/**
 * POST /api/bonus/daily/claim. Deliberately no amount, slice or currency field of any kind:
 * the server draws the slice, and `.strict()` refuses a body that tries to name one.
 */
export const dailyBonusClaimSchema = z
  .object({
    /** Client attempt token — a retried claim replays its original outcome (see AmoeClaim). */
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

export type DailyBonusClaimInput = z.infer<typeof dailyBonusClaimSchema>;
