-- The compensating credit's record.
--
-- A redemption debits SC_REDEEMABLE when the player asks. When the payout is then refused —
-- by an operator at review, or terminally by the rail — the SC is returned by a Zone 1
-- REDEMPTION_REFUND, and these two columns are where that fact lives.
--
-- refundLedgerTransactionId is UNIQUE for the same reason ledgerTransactionId is: one ledger
-- transaction can back at most one refund, so a double credit is not representable in the
-- schema rather than merely forbidden by the code.

-- AlterTable
ALTER TABLE "redemption_requests" ADD COLUMN     "refundLedgerTransactionId" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "redemption_requests_refundLedgerTransactionId_key" ON "redemption_requests"("refundLedgerTransactionId");

