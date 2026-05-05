-- Add resume structured JSON fields for project generation workflows
ALTER TABLE "Resume"
ADD COLUMN "parsedData" JSONB,
ADD COLUMN "metadataIndex" JSONB;

-- Credit usage ledger for non-session AI operations
CREATE TABLE "CreditUsage" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "resumeId" TEXT,
  "operation" TEXT NOT NULL,
  "creditsUsed" DECIMAL(10,2) NOT NULL,
  "aiModel" TEXT,
  "aiCostUsd" DECIMAL(10,4),
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "cached" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CreditUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditUsage_userId_idx" ON "CreditUsage"("userId");
CREATE INDEX "CreditUsage_resumeId_idx" ON "CreditUsage"("resumeId");
CREATE INDEX "CreditUsage_operation_idx" ON "CreditUsage"("operation");

ALTER TABLE "CreditUsage"
ADD CONSTRAINT "CreditUsage_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
