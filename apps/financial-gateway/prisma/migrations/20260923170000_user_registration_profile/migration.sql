-- AlterTable
ALTER TABLE "users" ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "residenceState" VARCHAR(2),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;

