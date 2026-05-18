/*
  Warnings:

  - The values [question,answer,context,system] on the enum `ChunkType` will be removed. If these variants are still used in the database, this will fail.
  - The values [assistant] on the enum `SpeakerType` will be removed. If these variants are still used in the database, this will fail.

*/
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

-- CreateTable
CREATE TABLE "AssistantChat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantChat_userId_updatedAt_idx" ON "AssistantChat"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "AssistantMessage_chatId_createdAt_idx" ON "AssistantMessage"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantMessage_userId_idx" ON "AssistantMessage"("userId");

-- AddForeignKey
ALTER TABLE "AssistantChat" ADD CONSTRAINT "AssistantChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantMessage" ADD CONSTRAINT "AssistantMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "AssistantChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
