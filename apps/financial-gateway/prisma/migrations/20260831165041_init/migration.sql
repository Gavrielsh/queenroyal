-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EngineRequestType" AS ENUM ('BET', 'WIN', 'DEPOSIT', 'ROLLBACK', 'PLAYER_CREATE');

-- CreateEnum
CREATE TYPE "EngineRequestStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'COMPENSATED', 'ABANDONED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "vipLevel" INTEGER NOT NULL DEFAULT 0,
    "trueEnginePlayerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "store_packages" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceUsdCents" INTEGER NOT NULL,
    "gc" INTEGER NOT NULL,
    "sc" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_trueEnginePlayerId_key" ON "users"("trueEnginePlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "engine_request_log_operatorTransactionId_key" ON "engine_request_log"("operatorTransactionId");

-- CreateIndex
CREATE INDEX "engine_request_log_status_updatedAt_idx" ON "engine_request_log"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "engine_request_log_createdAt_idx" ON "engine_request_log"("createdAt");
