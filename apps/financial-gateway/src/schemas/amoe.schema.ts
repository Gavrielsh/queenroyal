import { z } from "zod";

/**
 * POST /api/amoe/claim body.
 *
 * DELIBERATELY EMPTY OF MONEY. There is no `amount`, no `sc_amount`, and no coin field of any
 * kind — the grant is whatever config/amoe says it is, and the claimant does not get a say.
 *
 * That absence is the most important security property of this route. Every other money path
 * in the gateway accepts an amount and then spends effort proving the caller cannot abuse it:
 * schema bounds, policy caps, engine re-checks. Here the amount simply never crosses the
 * perimeter, so there is nothing to validate, nothing to tamper with, and no path from a
 * request body to the size of a free credit. The Zone 1 endpoint this dispatches to is
 * unbounded; a claimant-supplied amount would put that unbounded endpoint one JSON field away
 * from the public internet.
 *
 * `.strict()` makes an unexpected key a 422 rather than a silent ignore, so a client that
 * *tries* to send `{"sc_amount": "999999"}` learns it was refused instead of being quietly
 * granted the configured amount and assuming its field worked.
 */
export const amoeClaimSchema = z
  .object({
    /**
     * REQUIRED client-supplied attempt token, exactly as purchase and redeem require one. It
     * makes a double-submitted claim converge on one attempt rather than racing the period
     * unique index — the index would refuse the second write correctly, but a client retrying
     * a request whose response it never saw deserves its original outcome, not a
     * "you already claimed" it cannot distinguish from genuine abuse.
     */
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

export type AmoeClaimInput = z.infer<typeof amoeClaimSchema>;
