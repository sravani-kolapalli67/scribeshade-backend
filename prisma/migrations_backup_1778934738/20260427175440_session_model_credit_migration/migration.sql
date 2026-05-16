/*
  Warnings:

  - You are about to drop the column `isActive` on the `Session` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Session" DROP COLUMN "isActive",
ADD COLUMN     "bracketConfigSnapshot" JSONB,
ADD COLUMN     "creditExhaustedAt" TIMESTAMP(3),
ADD COLUMN     "creditsDeducted" DECIMAL(10,2),
ADD COLUMN     "creditsHeld" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "deductionReason" "DeductionReason",
ADD COLUMN     "durationSeconds" INTEGER,
ADD COLUMN     "maxAllowedMinutes" INTEGER,
ADD COLUMN     "pausedDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "SessionStatus" NOT NULL DEFAULT 'PRE_CHECK';

-- CreateIndex
CREATE INDEX "Session_status_idx" ON "Session"("status");
