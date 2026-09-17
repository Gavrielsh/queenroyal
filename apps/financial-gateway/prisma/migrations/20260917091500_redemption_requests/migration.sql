-- Money-out lifecycle: the redemption state machine.
--
-- `redemption_requests` orchestrates state ONLY. `amount` is TEXT because it is a frozen
-- decimal string forwarded verbatim to the Go engine — never a NUMERIC or DOUBLE this zone
-- could do arithmetic on. `ledgerTransactionId` is the single link to the Zone 1 ledger and
-- is UNIQUE, so one ledger transaction can back at most one redemption.
--
-- `ALTER TYPE … ADD VALUE` runs inside this migration's transaction, which PostgreSQL 12+
-- permits provided the new value is not USED in the same transaction. Nothing here uses it.

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED_BY_PLAYER');

-- AlterEnum
ALTER TYPE "EngineRequestType" ADD VALUE 'REDEEM';

-- CreateTable
CREATE TABLE "redemption_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'REQUESTED',
    "amount" TEXT NOT NULL,
    "operatorTransactionId" TEXT NOT NULL,
    "ledgerTransactionId" TEXT,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "payoutProviderRef" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redemption_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "redemption_requests_operatorTransactionId_key" ON "redemption_requests"("operatorTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "redemption_requests_ledgerTransactionId_key" ON "redemption_requests"("ledgerTransactionId");

-- CreateIndex
CREATE INDEX "redemption_requests_status_createdAt_idx" ON "redemption_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "redemption_requests_userId_createdAt_idx" ON "redemption_requests"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "redemption_requests" ADD CONSTRAINT "redemption_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

