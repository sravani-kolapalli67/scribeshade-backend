ALTER TABLE "AnswerGenerationSnapshot"
  ADD COLUMN "fromTranscriptChunkId" TEXT,
  ADD COLUMN "toTranscriptChunkId" TEXT,
  ADD COLUMN "detectedIntent" TEXT,
  ADD COLUMN "resolvedIntentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "questionGenerated" TEXT,
  ADD COLUMN "sessionStateSummary" TEXT,
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "decisionMetadata" JSONB DEFAULT '{}';

CREATE INDEX "AnswerGenerationSnapshot_sessionId_createdAt_idx"
  ON "AnswerGenerationSnapshot"("sessionId", "createdAt");
