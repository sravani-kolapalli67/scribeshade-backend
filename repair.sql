-- AlterEnum
BEGIN;
CREATE TYPE "ChunkType_new" AS ENUM ('QUESTION', 'ANSWER', 'CONTEXT', 'SYSTEM');
ALTER TABLE "TranscriptChunk" ALTER COLUMN "chunkType" TYPE "ChunkType_new" USING ("chunkType"::text::"ChunkType_new");
ALTER TYPE "ChunkType" RENAME TO "ChunkType_old";
ALTER TYPE "ChunkType_new" RENAME TO "ChunkType";
DROP TYPE "public"."ChunkType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "SpeakerType_new" AS ENUM ('interviewer', 'candidate', 'system');
ALTER TABLE "TranscriptChunk" ALTER COLUMN "speakerType" TYPE "SpeakerType_new" USING ("speakerType"::text::"SpeakerType_new");
ALTER TYPE "SpeakerType" RENAME TO "SpeakerType_old";
ALTER TYPE "SpeakerType_new" RENAME TO "SpeakerType";
DROP TYPE "public"."SpeakerType_old";
COMMIT;

-- AlterTable
ALTER TABLE "SessionFeedback" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "SessionNotes" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "BuiltResume_templateId_idx" ON "BuiltResume"("templateId");

-- CreateIndex
CREATE INDEX "CreditPurchase_packName_idx" ON "CreditPurchase"("packName");

-- CreateIndex
CREATE INDEX "Document_userId_idx" ON "Document"("userId");

-- CreateIndex
CREATE INDEX "Project_resumeId_idx" ON "Project"("resumeId");

-- CreateIndex
CREATE INDEX "Resume_userId_idx" ON "Resume"("userId");

-- CreateIndex
CREATE INDEX "Session_resumeId_idx" ON "Session"("resumeId");

-- CreateIndex
CREATE INDEX "Session_DocumentId_idx" ON "Session"("DocumentId");

-- CreateIndex
CREATE INDEX "SessionFeedback_userId_idx" ON "SessionFeedback"("userId");

-- CreateIndex
CREATE INDEX "SessionNotes_userId_idx" ON "SessionNotes"("userId");

-- CreateIndex
CREATE INDEX "TranscriptChunk_questionId_idx" ON "TranscriptChunk"("questionId");

-- AddForeignKey
ALTER TABLE "BuiltResume" ADD CONSTRAINT "BuiltResume_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ResumeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_DocumentId_fkey" FOREIGN KEY ("DocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionFeedback" ADD CONSTRAINT "SessionFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionNotes" ADD CONSTRAINT "SessionNotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_packName_fkey" FOREIGN KEY ("packName") REFERENCES "CreditPack"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditUsage" ADD CONSTRAINT "CreditUsage_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptChunk" ADD CONSTRAINT "TranscriptChunk_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QA"("id") ON DELETE SET NULL ON UPDATE CASCADE;

