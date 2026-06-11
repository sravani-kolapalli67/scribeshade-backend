-- CreateEnum
CREATE TYPE "SessionAIAnswerStatus" AS ENUM ('STREAMED', 'SAVED', 'SKIPPED', 'FAILED', 'STREAMED_VALID_SAVE_FAILED');

-- CreateTable
CREATE TABLE "SessionAIAnswerLedger" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "sourceTranscriptRange" JSONB,
    "answerStatus" "SessionAIAnswerStatus" NOT NULL DEFAULT 'STREAMED',
    "hasCode" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "messageId" TEXT,
    "qaId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionAIAnswerLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionAIAnswerLedger_sessionId_answerStatus_createdAt_idx" ON "SessionAIAnswerLedger"("sessionId", "answerStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SessionAIAnswerLedger_sessionId_createdAt_idx" ON "SessionAIAnswerLedger"("sessionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SessionAIAnswerLedger_messageId_idx" ON "SessionAIAnswerLedger"("messageId");

-- AddForeignKey
ALTER TABLE "SessionAIAnswerLedger" ADD CONSTRAINT "SessionAIAnswerLedger_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
