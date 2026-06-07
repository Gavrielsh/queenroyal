import { z } from "zod";

// All monetary amounts are non-negative INTEGERS in the engine's smallest unit.
const integerAmount = z
  .number()
  .int("Amount must be an integer (no floating point)")
  .nonnegative("Amount must be >= 0");

export const spinSchema = z.object({
  gameId: z.string().min(1, "gameId is required"),
  currency: z.enum(["GC", "SC"]),
  betAmount: integerAmount,
  winAmount: integerAmount.default(0),
});
export type SpinInput = z.infer<typeof spinSchema>;
