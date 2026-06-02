-- CreateTable
CREATE TABLE "SessionTopicMemory" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "topicTitle" TEXT NOT NULL,
    "topicKeywords" TEXT[],
    "currentSummary" TEXT NOT NULL,
    "lastQuestion" TEXT,
    "lastAnswer" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionTopicMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionTurnMemory" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "transcriptChunkId" TEXT,
    "topicId" TEXT,
    "questionRaw" TEXT NOT NULL,
    "questionClean" TEXT NOT NULL,
    "answerRaw" TEXT NOT NULL,
    "answerSummary" TEXT NOT NULL,
    "answerType" TEXT NOT NULL,
    "codeBlocks" JSONB,
    "keyClaims" TEXT[],
    "followupKeys" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionTurnMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateContextDigest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "documentId" TEXT,
    "projectIds" TEXT[],
    "sourceHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "errorMessage" TEXT,
    "resumeDigest" TEXT NOT NULL,
    "skills" TEXT[],
    "projectCards" JSONB NOT NULL,
    "experienceFacts" JSONB NOT NULL,
    "domainKeywords" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateContextDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionTopicMemory_sessionId_active_idx" ON "SessionTopicMemory"("sessionId", "active");

-- CreateIndex
CREATE INDEX "SessionTopicMemory_sessionId_updatedAt_idx" ON "SessionTopicMemory"("sessionId", "updatedAt");

-- CreateIndex
CREATE INDEX "SessionTurnMemory_sessionId_createdAt_idx" ON "SessionTurnMemory"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionTurnMemory_sessionId_topicId_createdAt_idx" ON "SessionTurnMemory"("sessionId", "topicId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateContextDigest_sessionId_key" ON "CandidateContextDigest"("sessionId");

-- CreateIndex
CREATE INDEX "CandidateContextDigest_sourceHash_idx" ON "CandidateContextDigest"("sourceHash");

-- CreateIndex
CREATE INDEX "CandidateContextDigest_status_idx" ON "CandidateContextDigest"("status");

-- AddForeignKey
ALTER TABLE "SessionTopicMemory" ADD CONSTRAINT "SessionTopicMemory_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionTurnMemory" ADD CONSTRAINT "SessionTurnMemory_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionTurnMemory" ADD CONSTRAINT "SessionTurnMemory_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "SessionTopicMemory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateContextDigest" ADD CONSTRAINT "CandidateContextDigest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
