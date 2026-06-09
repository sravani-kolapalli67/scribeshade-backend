CREATE TYPE "SessionAnswerRevisionSource" AS ENUM (
  'ORIGINAL',
  'MANUAL',
  'AI_REWRITE',
  'AI_REGENERATE',
  'RESTORE'
);

ALTER TABLE "QA"
ADD COLUMN "messageId" TEXT;

CREATE UNIQUE INDEX "QA_messageId_key" ON "QA"("messageId");

CREATE TABLE "SessionAnswerRevision" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "qaId" TEXT,
  "userId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "source" "SessionAnswerRevisionSource" NOT NULL,
  "aiMode" TEXT,
  "instruction" TEXT,
  "model" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SessionAnswerRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SessionAnswerRevision_sessionId_messageId_version_key"
ON "SessionAnswerRevision"("sessionId", "messageId", "version");

CREATE INDEX "SessionAnswerRevision_sessionId_messageId_createdAt_idx"
ON "SessionAnswerRevision"("sessionId", "messageId", "createdAt" DESC);

CREATE INDEX "SessionAnswerRevision_qaId_idx"
ON "SessionAnswerRevision"("qaId");

CREATE INDEX "SessionAnswerRevision_userId_idx"
ON "SessionAnswerRevision"("userId");

ALTER TABLE "SessionAnswerRevision"
ADD CONSTRAINT "SessionAnswerRevision_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "Session"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SessionAnswerRevision"
ADD CONSTRAINT "SessionAnswerRevision_qaId_fkey"
FOREIGN KEY ("qaId") REFERENCES "QA"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SessionAnswerRevision"
ADD CONSTRAINT "SessionAnswerRevision_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
