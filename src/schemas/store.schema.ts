import { z } from "zod";

export const purchaseSchema = z.object({
  packageId: z.string().min(1, "packageId is required"),
  // Mock PSP token. In production this is a real Stripe PaymentMethod / token id.
  // Use "tok_decline" to simulate a declined card.
  paymentToken: z.string().min(1).default("tok_mock_visa"),
  // Optional client-supplied idempotency key for the PSP charge, so a double-submit
  // captures the card only once. (The ledger credit is independently de-duplicated via
  // an operator_transaction_id derived from the PSP payment_ref.)
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type PurchaseInput = z.infer<typeof purchaseSchema>;
