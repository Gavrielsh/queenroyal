import { z } from "zod";

export const purchaseSchema = z.object({
  packageId: z.string().min(1, "packageId is required"),
  // Mock PSP token. In production this is a real Stripe PaymentMethod / token id.
  // Use "tok_decline" to simulate a declined card.
  paymentToken: z.string().min(1).default("tok_mock_visa"),
});
export type PurchaseInput = z.infer<typeof purchaseSchema>;
