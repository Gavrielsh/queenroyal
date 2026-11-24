-- 20260918080000_kyc_verification
--
-- Phase C, task C3 — the KYC provider seam, document upload, and decision webhook.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- READ THE COLUMN LIST FOR WHAT IS NOT IN IT
-- ─────────────────────────────────────────────────────────────────────────────
-- `kyc_documents` has no BYTEA, no base64 TEXT, no data URI, and no field of any
-- name that could hold a file. That absence is the feature.
--
-- Identity documents are the most sensitive data this platform will ever handle.
-- The client PUTs each file straight to the provider's presigned URL; these rows
-- record only that it happened, and `provider_upload_ref` is the sole link
-- between a row and a file that lives at the provider and nowhere else.
--
-- Bytes in this database would be in every backup, every read replica, every
-- logical-replication stream, and every pg_dump a support engineer ever took. A
-- breach would then involve government identity documents rather than a list of
-- email addresses. Adding such a column later must therefore be a migration
-- somebody writes and somebody reviews — not a line somebody adds to a model.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE IDEMPOTENCY ANCHOR
-- ─────────────────────────────────────────────────────────────────────────────
--     CREATE UNIQUE INDEX "kyc_webhook_events_providerEventId_key" ...
--
-- Every real provider redelivers: on timeout, on a 5xx, and often simply because
-- the vendor's queue is at-least-once. The same decision therefore arrives many
-- times, sometimes out of order and sometimes concurrently.
--
-- Inferring "have I seen this?" from the case's current status does not survive
-- that — two redeliveries racing each other both read the old status, both
-- decide to act, and both act. Inserting the event row FIRST turns the question
-- into a unique violation, which Postgres answers correctly however the
-- deliveries interleave. The service catches the P2002 and reports the original
-- outcome.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS NOT
-- ─────────────────────────────────────────────────────────────────────────────
-- Not financial state, like everything else in this schema. A KYC decision gates
-- whether a player may redeem; it holds no balance and moves no money. The
-- ledger in Zone 1 remains the only place money lives.

-- CreateEnum
CREATE TYPE "KycCaseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID', 'PROOF_OF_ADDRESS', 'SELFIE');

-- CreateTable
CREATE TABLE "kyc_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerCaseRef" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "KycCaseStatus" NOT NULL DEFAULT 'PENDING',
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "documentType" "KycDocumentType" NOT NULL,
    "providerUploadRef" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "uploadExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_webhook_events" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "caseRef" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_verifications_providerCaseRef_key" ON "kyc_verifications"("providerCaseRef");

-- CreateIndex
CREATE INDEX "kyc_verifications_userId_createdAt_idx" ON "kyc_verifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "kyc_verifications_status_createdAt_idx" ON "kyc_verifications"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_documents_providerUploadRef_key" ON "kyc_documents"("providerUploadRef");

-- CreateIndex
CREATE INDEX "kyc_documents_verificationId_createdAt_idx" ON "kyc_documents"("verificationId", "createdAt");

-- CreateIndex
CREATE INDEX "kyc_documents_userId_createdAt_idx" ON "kyc_documents"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_webhook_events_providerEventId_key" ON "kyc_webhook_events"("providerEventId");

-- CreateIndex
CREATE INDEX "kyc_webhook_events_caseRef_receivedAt_idx" ON "kyc_webhook_events"("caseRef", "receivedAt");

-- AddForeignKey
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "kyc_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

