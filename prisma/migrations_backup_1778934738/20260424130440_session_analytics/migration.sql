-- CreateTable
CREATE TABLE "SessionFeedback" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "confidence" INTEGER NOT NULL,
    "sessionQuality" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "communication" INTEGER NOT NULL,
    "interactivity" INTEGER NOT NULL,
    "technicalDepth" INTEGER NOT NULL,
    "conciseness" INTEGER NOT NULL,
    "avgResponseLen" INTEGER NOT NULL,
    "answeredCount" INTEGER NOT NULL,
    "aiAssistsCount" INTEGER NOT NULL,
    "avgResponseTime" DOUBLE PRECISION NOT NULL,
    "strengths" TEXT[],
    "improvements" TEXT[],
    "interviewerMood" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionFeedback_sessionId_key" ON "SessionFeedback"("sessionId");

-- AddForeignKey
ALTER TABLE "SessionFeedback" ADD CONSTRAINT "SessionFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
