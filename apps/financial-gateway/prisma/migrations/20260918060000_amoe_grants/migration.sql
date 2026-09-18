-- 20260918060000_amoe_grants
--
-- Phase C, task C2 — the Alternative Method of Entry.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE LINE THAT MATTERS IN THIS FILE
-- ─────────────────────────────────────────────────────────────────────────────
--     CREATE UNIQUE INDEX "amoe_grants_userId_grantPeriod_key"
--         ON "amoe_grants"("userId", "grantPeriod");
--
-- The Zone 1 promo-grant endpoint is deliberately unbounded: the ledger issues
-- what an authenticated operator asks for, because its job is to record
-- movements correctly rather than to decide who deserves one. Frequency capping
-- is therefore entirely Zone 2's, and this index is the whole of it.
--
-- It is a DATABASE constraint and not a service-layer check because the two
-- behave differently under exactly the traffic this route invites. A
-- read-then-write in application code ("has this player claimed this period?"
-- then INSERT) is passed by BOTH of two concurrent claims — each reads before
-- the other writes — and the second free grant is issued. Postgres refuses the
-- second INSERT no matter how the requests interleave. The service catches the
-- resulting P2002 and reports it as a clean refusal.
--
-- The second unique, on (userId, claimAttemptKey), is a different control for a
-- different failure: it lets a client that never saw its response replay the
-- ORIGINAL outcome instead of being told the period is spent — which it would
-- have no way to tell apart from genuine abuse. Per user, not global, because
-- the token is client-chosen and two strangers picking the same string must not
-- be able to read or block each other's claim.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TYPE OUTSIDE A TRANSACTION
-- ─────────────────────────────────────────────────────────────────────────────
-- `ALTER TYPE "EngineRequestType" ADD VALUE 'PROMO_GRANT'` below adds an enum
-- value. PostgreSQL permits this inside a transaction block but forbids USING
-- the new value in that same transaction. Nothing here uses it — the value is
-- only ever written by the application, in a later transaction — so this is
-- safe under every runner. The same rule, and the same reasoning, as the
-- engine's migration 000013.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS TABLE IS NOT
-- ─────────────────────────────────────────────────────────────────────────────
-- Not financial state. `scAmount` and `gcAmount` are TEXT and are intent
-- parameters — a verbatim copy of what was asked for, written once and never
-- recomputed — exactly as `redemption_requests.amount` is. Summing them does
-- not yield a balance and must never be used as one: REQUESTED and FAILED rows
-- moved no coins at all. The ledger in Zone 1 is the only place the truth lives.

-- CreateEnum
CREATE TYPE "AmoeGrantStatus" AS ENUM ('REQUESTED', 'GRANTED', 'FAILED');

-- AlterEnum
ALTER TYPE "EngineRequestType" ADD VALUE 'PROMO_GRANT';

-- CreateTable
CREATE TABLE "amoe_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "grantPeriod" TEXT NOT NULL,
    "status" "AmoeGrantStatus" NOT NULL DEFAULT 'REQUESTED',
    "scAmount" TEXT NOT NULL,
    "gcAmount" TEXT NOT NULL,
    "operatorTransactionId" TEXT NOT NULL,
    "ledgerTransactionId" TEXT,
    "channelReference" TEXT NOT NULL,
    "claimAttemptKey" TEXT NOT NULL,
    "claimIp" TEXT,
    "claimJurisdiction" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amoe_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "amoe_grants_operatorTransactionId_key" ON "amoe_grants"("operatorTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "amoe_grants_ledgerTransactionId_key" ON "amoe_grants"("ledgerTransactionId");

-- CreateIndex
CREATE INDEX "amoe_grants_userId_createdAt_idx" ON "amoe_grants"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "amoe_grants_claimIp_createdAt_idx" ON "amoe_grants"("claimIp", "createdAt");

-- CreateIndex
CREATE INDEX "amoe_grants_status_createdAt_idx" ON "amoe_grants"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "amoe_grants_userId_grantPeriod_key" ON "amoe_grants"("userId", "grantPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "amoe_grants_userId_claimAttemptKey_key" ON "amoe_grants"("userId", "claimAttemptKey");

-- AddForeignKey
ALTER TABLE "amoe_grants" ADD CONSTRAINT "amoe_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

