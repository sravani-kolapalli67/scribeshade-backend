-- Migration: Create AssistantChat and AssistantMessage tables
-- Run with: pnpm exec prisma db execute --file prisma/migrations/create_assistant_tables.sql

CREATE TABLE IF NOT EXISTS "AssistantChat" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"    TEXT NOT NULL,
  "title"     TEXT NOT NULL DEFAULT 'New Chat',
  "sessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantChat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssistantMessage" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "chatId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "role"      "MessageRole" NOT NULL,
  "content"   TEXT NOT NULL,
  "citations" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AssistantChat_userId_fkey'
  ) THEN
    ALTER TABLE "AssistantChat"
      ADD CONSTRAINT "AssistantChat_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AssistantMessage_chatId_fkey'
  ) THEN
    ALTER TABLE "AssistantMessage"
      ADD CONSTRAINT "AssistantMessage_chatId_fkey"
      FOREIGN KEY ("chatId") REFERENCES "AssistantChat"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AssistantChat_userId_updatedAt_idx"
  ON "AssistantChat"("userId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "AssistantMessage_chatId_createdAt_idx"
  ON "AssistantMessage"("chatId", "createdAt");

CREATE INDEX IF NOT EXISTS "AssistantMessage_userId_idx"
  ON "AssistantMessage"("userId");
