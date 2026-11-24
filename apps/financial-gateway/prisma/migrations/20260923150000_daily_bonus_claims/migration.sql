-- 20260923150000_daily_bonus_claims
--
-- The Daily Wheel: one server-drawn spin per player per gaming day, granted through the
-- engine's promo-grant endpoint on the BONUS channel (engine migration 000010).
--
-- THE LINE THAT MATTERS:
--     CREATE UNIQUE INDEX "daily_bonus_claims_userId_gamingDate_key"
--         ON "daily_bonus_claims"("userId", "gamingDate");
--
-- Zone 1 applies no cap to promo grants, so this index is the whole frequency cap — the same
-- design, and the same reasoning, as amoe_grants (20260918060000). The row is inserted BEFORE
-- the engine is called; two concurrent claims cannot both survive the INSERT.
--
-- gcAmount / scAmount are TEXT intent parameters (the drawn slice, verbatim), never balances.
--
-- Generated with `prisma migrate diff` from the schema change, so it matches the datamodel.

-- CreateEnum
CREATE TYPE "DailyBonusStatus" AS ENUM ('REQUESTED', 'GRANTED', 'FAILED');

-- CreateTable
CREATE TABLE "daily_bonus_claims" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "gamingDate" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "status" "DailyBonusStatus" NOT NULL DEFAULT 'REQUESTED',
    "gcAmount" TEXT NOT NULL,
    "scAmount" TEXT NOT NULL,
    "operatorTransactionId" TEXT NOT NULL,
    "ledgerTransactionId" TEXT,
    "channelReference" TEXT NOT NULL,
    "claimAttemptKey" TEXT NOT NULL,
    "claimIp" TEXT,
    "claimJurisdiction" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_bonus_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_bonus_claims_operatorTransactionId_key" ON "daily_bonus_claims"("operatorTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_bonus_claims_ledgerTransactionId_key" ON "daily_bonus_claims"("ledgerTransactionId");

-- CreateIndex
CREATE INDEX "daily_bonus_claims_userId_createdAt_idx" ON "daily_bonus_claims"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "daily_bonus_claims_status_createdAt_idx" ON "daily_bonus_claims"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "daily_bonus_claims_userId_gamingDate_key" ON "daily_bonus_claims"("userId", "gamingDate");

-- CreateIndex
CREATE UNIQUE INDEX "daily_bonus_claims_userId_claimAttemptKey_key" ON "daily_bonus_claims"("userId", "claimAttemptKey");

-- AddForeignKey
ALTER TABLE "daily_bonus_claims" ADD CONSTRAINT "daily_bonus_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

