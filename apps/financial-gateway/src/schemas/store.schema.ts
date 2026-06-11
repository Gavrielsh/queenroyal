import { z } from "zod";

export const purchaseSchema = z.object({
  packageId: z.string().min(1, "packageId is required"),
  // Optional client-supplied idempotency key. It anchors BOTH the PSP PaymentIntent (so a
  // double-submit opens the card intent only once) AND the ledger credit's
  // operator_transaction_id (`deposit:<key>`), so settlement de-duplicates on retry.
  //
  // NOTE: no card token is accepted here. In the async model the backend opens a
  // PaymentIntent and returns a `client_secret`; the FRONTEND collects the card and confirms
  // it (handling any 3DS/SCA) — raw payment instruments never touch this service.
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type PurchaseInput = z.infer<typeof purchaseSchema>;

// Dev-only stand-in for the Stripe.js card confirmation: identifies which previously-opened
// mock PaymentIntent to advance to `succeeded`. Never used with a real PSP.
export const mockConfirmSchema = z.object({
  paymentIntentId: z.string().min(1, "paymentIntentId is required"),
});
export type MockConfirmInput = z.infer<typeof mockConfirmSchema>;
