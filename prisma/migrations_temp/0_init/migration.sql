CREATE EXTENSION IF NOT EXISTS vector;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."ChunkType" AS ENUM ('question', 'answer', 'context', 'system');

-- CreateEnum
CREATE TYPE "public"."DeductionReason" AS ENUM ('FREE_ZONE', 'HALF_BRACKET', 'FULL_BRACKET', 'EXHAUSTED', 'FORCE_ENDED', 'REFUND', 'BRACKET_OVERFLOW', 'PER_MINUTE_DEDUCTION', 'CAP_REACHED', 'ABANDONED', 'AUTO_ENDED');

-- CreateEnum
CREATE TYPE "public"."Difficulty" AS ENUM ('Easy', 'Medium', 'Hard');

-- CreateEnum
CREATE TYPE "public"."IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."Industry" AS ENUM ('DSA', 'Full_Stack', 'Data_Science', 'DevOps', 'System_Design', 'Mobile', 'Cloud');

-- CreateEnum
CREATE TYPE "public"."Language" AS ENUM ('JavaScript', 'TypeScript', 'Python', 'Java', 'C_Plus_Plus', 'C', 'C_Sharp', 'Go', 'General');

-- CreateEnum
CREATE TYPE "public"."LedgerType" AS ENUM ('DEBIT', 'PURCHASE', 'REFUND', 'EARN');

-- CreateEnum
CREATE TYPE "public"."MessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "public"."PackFeature" AS ENUM ('INTERVIEW_SESSION');

-- CreateEnum
CREATE TYPE "public"."PackTier" AS ENUM ('QUICK', 'STARTER', 'BASIC', 'STANDARD', 'PROFESSIONAL', 'POWER', 'MEGA');

-- CreateEnum
CREATE TYPE "public"."PurchaseStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."SessionStatus" AS ENUM ('PRE_CHECK', 'ACTIVE', 'PAUSED', 'COMPLETING', 'COMPLETED', 'ABANDONED', 'FORCE_ENDED', 'CREDIT_EXHAUSTED', 'DISCONNECTED', 'AUTO_ENDED');

-- CreateEnum
CREATE TYPE "public"."SpeakerType" AS ENUM ('interviewer', 'candidate', 'system', 'assistant');

-- CreateEnum
CREATE TYPE "public"."SupportedCurrency" AS ENUM ('INR', 'USD', 'GBP');

-- CreateTable
CREATE TABLE "public"."ATSAnalysis" (
    "id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "missingKeywords" TEXT[],
    "suggestions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumeId" TEXT NOT NULL,

    CONSTRAINT "ATSAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AiGenerationCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL DEFAULT '',
    "operation" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "creditsCharged" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiGenerationCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AskAiMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "public"."MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AskAiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BuiltResume" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "sections" JSONB NOT NULL,
    "jobDescription" TEXT,
    "jobTitle" TEXT,
    "company" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "downloadedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "atsScore" INTEGER,
    "lastAtsAt" TIMESTAMP(3),
    "lastAtsResult" JSONB,

    CONSTRAINT "BuiltResume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditConfig" (
    "id" TEXT NOT NULL,
    "bracketMinutes" INTEGER NOT NULL,
    "creditsFull" DECIMAL(10,2) NOT NULL,
    "creditsHalf" DECIMAL(10,2) NOT NULL,
    "freeZoneMinutes" INTEGER NOT NULL DEFAULT 5,
    "graceZoneMinutes" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "type" "public"."LedgerType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "balanceBefore" DECIMAL(10,2) NOT NULL,
    "balanceAfter" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditPack" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tier" "public"."PackTier" NOT NULL,
    "name" TEXT NOT NULL,
    "credits" DECIMAL(10,2) NOT NULL,
    "feature" "public"."PackFeature" NOT NULL DEFAULT 'INTERVIEW_SESSION',
    "priceInr" DECIMAL(10,2) NOT NULL,
    "priceUsd" DECIMAL(10,2) NOT NULL,
    "priceGbp" DECIMAL(10,2) NOT NULL,
    "valuePct" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPopular" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packName" TEXT NOT NULL,
    "creditsPurchased" DECIMAL(10,2) NOT NULL,
    "creditsRemaining" DECIMAL(10,2) NOT NULL,
    "paymentProviderEventId" TEXT NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "public"."PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditUsage" (
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

-- CreateTable
CREATE TABLE "public"."Document" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FeatureCost" (
    "id" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "credits" DECIMAL(10,2) NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."IdempotencyKey" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "public"."IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseBody" JSONB,
    "statusCode" INTEGER,
    "creditsUsed" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "public"."Policy" (
    "id" TEXT NOT NULL,
    "privacyPolicy" TEXT NOT NULL,
    "termsAndConditions" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Project" (
    "id" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "jobDescription" TEXT NOT NULL,
    "resumeId" TEXT,
    "projects" JSONB NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "experienceLevel" TEXT,
    "industry" TEXT,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProjectVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "projects" JSONB NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QA" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT,
    "ques" TEXT NOT NULL,
    "answer" TEXT,
    "difficulty" "public"."Difficulty" NOT NULL DEFAULT 'Easy',
    "industry" "public"."Industry" NOT NULL DEFAULT 'DSA',
    "language" "public"."Language" NOT NULL DEFAULT 'General',
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,

    CONSTRAINT "QA_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Resume" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "resumeContext" TEXT,
    "size" INTEGER,
    "ats" BOOLEAN NOT NULL DEFAULT false,
    "metadataIndex" JSONB,
    "parsedData" JSONB,

    CONSTRAINT "Resume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ResumeTemplate" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,

    CONSTRAINT "ResumeTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "extraContext" TEXT NOT NULL,
    "free" BOOLEAN NOT NULL,
    "language" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "saveTranscription" BOOLEAN NOT NULL,
    "simpleLanguage" BOOLEAN NOT NULL DEFAULT true,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "DocumentId" TEXT NOT NULL,
    "autoGenerateResponse" BOOLEAN NOT NULL,
    "jobDescription" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "messages" JSONB NOT NULL DEFAULT '[]',
    "companyId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "aiUsage" INTEGER NOT NULL DEFAULT 0,
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "bracketConfigSnapshot" JSONB,
    "creditExhaustedAt" TIMESTAMP(3),
    "creditsDeducted" DECIMAL(10,2),
    "creditsHeld" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deductionReason" "public"."DeductionReason",
    "durationSeconds" INTEGER,
    "maxAllowedMinutes" INTEGER,
    "pausedDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."SessionStatus" NOT NULL DEFAULT 'PRE_CHECK',
    "projectIds" JSONB NOT NULL DEFAULT '[]',
    "lastHeartbeatAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SessionFeedback" (
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

-- CreateTable
CREATE TABLE "public"."SessionNotes" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "jobDescription" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionNotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TranscriptChunk" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT,
    "question" TEXT,
    "aiAnswer" TEXT,
    "content" TEXT NOT NULL,
    "technologies" TEXT[],
    "difficulty" TEXT,
    "startTime" DOUBLE PRECISION,
    "endTime" DOUBLE PRECISION,
    "speakerType" "public"."SpeakerType",
    "embedding" vector(2560),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chunkOrder" INTEGER,
    "chunkType" "public"."ChunkType",
    "isQuestion" BOOLEAN NOT NULL DEFAULT false,
    "questionGroupId" TEXT,

    CONSTRAINT "TranscriptChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserCreditBalance" (
    "userId" TEXT NOT NULL,
    "purchasedCredits" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "earnedCredits" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "heldCredits" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAvailable" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCreditBalance_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ATSAnalysis_resumeId_key" ON "public"."ATSAnalysis"("resumeId" ASC);

-- CreateIndex
CREATE INDEX "AiGenerationCache_expiresAt_idx" ON "public"."AiGenerationCache"("expiresAt" ASC);

-- CreateIndex
CREATE INDEX "AiGenerationCache_userId_idx" ON "public"."AiGenerationCache"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "AiGenerationCache_userId_operation_resumeId_inputHash_key" ON "public"."AiGenerationCache"("userId" ASC, "operation" ASC, "resumeId" ASC, "inputHash" ASC);

-- CreateIndex
CREATE INDEX "AskAiMessage_sessionId_createdAt_idx" ON "public"."AskAiMessage"("sessionId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "AskAiMessage_userId_idx" ON "public"."AskAiMessage"("userId" ASC);

-- CreateIndex
CREATE INDEX "BuiltResume_userId_idx" ON "public"."BuiltResume"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "public"."Company"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "public"."Company"("slug" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CreditConfig_bracketMinutes_key" ON "public"."CreditConfig"("bracketMinutes" ASC);

-- CreateIndex
CREATE INDEX "CreditLedger_sessionId_idx" ON "public"."CreditLedger"("sessionId" ASC);

-- CreateIndex
CREATE INDEX "CreditLedger_userId_idx" ON "public"."CreditLedger"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CreditPack_code_key" ON "public"."CreditPack"("code" ASC);

-- CreateIndex
CREATE INDEX "CreditPack_isActive_idx" ON "public"."CreditPack"("isActive" ASC);

-- CreateIndex
CREATE INDEX "CreditPack_tier_idx" ON "public"."CreditPack"("tier" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_paymentProviderEventId_key" ON "public"."CreditPurchase"("paymentProviderEventId" ASC);

-- CreateIndex
CREATE INDEX "CreditPurchase_userId_idx" ON "public"."CreditPurchase"("userId" ASC);

-- CreateIndex
CREATE INDEX "CreditUsage_operation_idx" ON "public"."CreditUsage"("operation" ASC);

-- CreateIndex
CREATE INDEX "CreditUsage_resumeId_idx" ON "public"."CreditUsage"("resumeId" ASC);

-- CreateIndex
CREATE INDEX "CreditUsage_userId_idx" ON "public"."CreditUsage"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureCost_featureKey_key" ON "public"."FeatureCost"("featureKey" ASC);

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "public"."IdempotencyKey"("expiresAt" ASC);

-- CreateIndex
CREATE INDEX "IdempotencyKey_operation_idx" ON "public"."IdempotencyKey"("operation" ASC);

-- CreateIndex
CREATE INDEX "IdempotencyKey_userId_idx" ON "public"."IdempotencyKey"("userId" ASC);

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "public"."Project"("userId" ASC);

-- CreateIndex
CREATE INDEX "ProjectVersion_projectId_idx" ON "public"."ProjectVersion"("projectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectVersion_projectId_versionNumber_key" ON "public"."ProjectVersion"("projectId" ASC, "versionNumber" ASC);

-- CreateIndex
CREATE INDEX "QA_companyId_idx" ON "public"."QA"("companyId" ASC);

-- CreateIndex
CREATE INDEX "QA_isShared_idx" ON "public"."QA"("isShared" ASC);

-- CreateIndex
CREATE INDEX "QA_sessionId_idx" ON "public"."QA"("sessionId" ASC);

-- CreateIndex
CREATE INDEX "QA_userId_idx" ON "public"."QA"("userId" ASC);

-- CreateIndex
CREATE INDEX "Session_companyId_idx" ON "public"."Session"("companyId" ASC);

-- CreateIndex
CREATE INDEX "Session_status_idx" ON "public"."Session"("status" ASC);

-- CreateIndex
CREATE INDEX "Session_userId_createdAt_idx" ON "public"."Session"("userId" ASC, "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SessionFeedback_sessionId_key" ON "public"."SessionFeedback"("sessionId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SessionNotes_sessionId_key" ON "public"."SessionNotes"("sessionId" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_sessionId_chunkOrder_idx" ON "public"."TranscriptChunk"("sessionId" ASC, "chunkOrder" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_sessionId_createdAt_idx" ON "public"."TranscriptChunk"("sessionId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_sessionId_questionGroupId_idx" ON "public"."TranscriptChunk"("sessionId" ASC, "questionGroupId" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_sessionId_speakerType_createdAt_idx" ON "public"."TranscriptChunk"("sessionId" ASC, "speakerType" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_userId_idx" ON "public"."TranscriptChunk"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "public"."User"("clerkId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email" ASC);

-- AddForeignKey
ALTER TABLE "public"."ATSAnalysis" ADD CONSTRAINT "ATSAnalysis_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "public"."Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AiGenerationCache" ADD CONSTRAINT "AiGenerationCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AskAiMessage" ADD CONSTRAINT "AskAiMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AskAiMessage" ADD CONSTRAINT "AskAiMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuiltResume" ADD CONSTRAINT "BuiltResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditPurchase" ADD CONSTRAINT "CreditPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditUsage" ADD CONSTRAINT "CreditUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Document" ADD CONSTRAINT "Document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectVersion" ADD CONSTRAINT "ProjectVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QA" ADD CONSTRAINT "QA_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QA" ADD CONSTRAINT "QA_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QA" ADD CONSTRAINT "QA_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Resume" ADD CONSTRAINT "Resume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SessionFeedback" ADD CONSTRAINT "SessionFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SessionNotes" ADD CONSTRAINT "SessionNotes_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TranscriptChunk" ADD CONSTRAINT "TranscriptChunk_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TranscriptChunk" ADD CONSTRAINT "TranscriptChunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserCreditBalance" ADD CONSTRAINT "UserCreditBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

