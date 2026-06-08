-- Incremental schema change for the gateway alignment work:
--   * User.trueEnginePlayerId  (identity bridge to the True Engine player_id)
--   * engine_request_log        (append-only intent journal / outbox — NO balances)
--   * EngineRequestType / EngineRequestStatus enums
--
-- Generated with:
--   prisma migrate diff \
--     --from-schema-datamodel <pre-change schema> \
--     --to-schema-datamodel prisma/schema.prisma --script
--
-- Apply this ONLY if you are managing the schema by hand. The supported path is the
-- Prisma CLI (see prisma/MIGRATIONS.md): `prisma migrate dev` / `migrate deploy`, or
-- `prisma db push` for the current no-migration-history setup.

-- CreateEnum
CREATE TYPE "EngineRequestType" AS ENUM ('BET', 'WIN', 'DEPOSIT', 'ROLLBACK', 'PLAYER_CREATE');

-- CreateEnum
CREATE TYPE "EngineRequestStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'COMPENSATED', 'ABANDONED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "trueEnginePlayerId" TEXT;

-- CreateTable
CREATE TABLE "engine_request_log" (
    "id" TEXT NOT NULL,
    "operatorTransactionId" TEXT NOT NULL,
    "type" "EngineRequestType" NOT NULL,
    "status" "EngineRequestStatus" NOT NULL DEFAULT 'PENDING',
    "playerId" TEXT,
    "providerRef" TEXT,
    "ledgerTransactionId" TEXT,
    "requestPayload" JSONB,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engine_request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "engine_request_log_operatorTransactionId_key" ON "engine_request_log"("operatorTransactionId");

-- CreateIndex
CREATE INDEX "engine_request_log_status_updatedAt_idx" ON "engine_request_log"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_trueEnginePlayerId_key" ON "users"("trueEnginePlayerId");
