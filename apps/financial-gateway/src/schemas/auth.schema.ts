import { z } from "zod";

import { parseDateKey, US_STATES } from "../lib/registration-policy";

export const registerSchema = z.object({
  email: z.string().trim().email("A valid email is required").toLowerCase(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
  // Declared here, proven by KYC. The age and residence RULES live in auth.service (they
  // depend on the clock and on BLOCKED_REGIONS); the schema only checks the shape.
  dateOfBirth: z
    .string()
    .refine((v) => parseDateKey(v) !== null, "Date of birth must be a valid YYYY-MM-DD date"),
  residenceState: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => US_STATES.has(v), "Residence must be a US state code"),
  acceptTerms: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Terms of Service and Official Sweepstakes Rules" }),
  }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().email("A valid email is required").toLowerCase(),
  password: z.string().min(1, "Password is required").max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;
