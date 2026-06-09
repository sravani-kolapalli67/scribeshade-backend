-- CreateEnum
CREATE TYPE "public"."QuestionBankDifficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD', 'EXPERT');

-- CreateEnum
CREATE TYPE "public"."QuestionBankQuestionType" AS ENUM ('CODING', 'DSA', 'SYSTEM_DESIGN', 'ARCHITECTURE', 'TECHNICAL_CONCEPT', 'SCENARIO_BASED', 'DEBUGGING', 'DATABASE', 'CLOUD_DEVOPS', 'BEHAVIORAL', 'PROJECT_DEEP_DIVE', 'CASE_STUDY', 'SQL', 'FRONTEND', 'BACKEND', 'DATA_ENGINEERING', 'SECURITY', 'TESTING');

-- CreateEnum
CREATE TYPE "public"."QuestionBankVisibility" AS ENUM ('PRIVATE', 'PUBLIC_CANDIDATE', 'PUBLIC_AGGREGATED', 'ADMIN_HIDDEN');

-- CreateEnum
CREATE TYPE "public"."QuestionBankVisibilityClass" AS ENUM ('VALID_INTERVIEW_QUESTION', 'LOW_VALUE_HR_QUESTION', 'PRIVACY_SENSITIVE_QUESTION', 'TRANSCRIPT_NOISE', 'DUPLICATE', 'UNSAFE_TO_PUBLISH');

-- CreateEnum
CREATE TYPE "public"."QuestionBankSourceType" AS ENUM ('MANUAL', 'SESSION_EXTRACTED', 'ADMIN_IMPORTED', 'PUBLIC_CONTRIBUTION');

-- CreateEnum
CREATE TYPE "public"."QuestionBankModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NEEDS_REVIEW', 'AUTO_APPROVED');

-- CreateEnum
CREATE TYPE "public"."QuestionBankPrivacyRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "public"."QuestionBankExtractionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "public"."Session" ADD COLUMN "questionBankContributionOptIn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public"."QuestionBankCompany" (
    "id" TEXT NOT NULL,
    "existingCompanyId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "aliases" TEXT[],
    "industry" TEXT,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuestionBankRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "seniority" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuestionBankTechnology" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "aliases" TEXT[],
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankTechnology_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuestionBankCluster" (
    "id" TEXT NOT NULL,
    "canonicalQuestion" TEXT NOT NULL,
    "canonicalHash" TEXT NOT NULL,
    "embeddingVectorId" TEXT,
    "companyId" TEXT,
    "roleId" TEXT,
    "technologies" TEXT[],
    "topics" TEXT[],
    "frequencyCount" INTEGER NOT NULL DEFAULT 0,
    "contributorCount" INTEGER NOT NULL DEFAULT 0,
    "sourceSessionCount" INTEGER NOT NULL DEFAULT 0,
    "publicEligible" BOOLEAN NOT NULL DEFAULT false,
    "publicReason" TEXT,
    "adminOverride" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuestionBankQuestion" (
    "id" TEXT NOT NULL,
    "normalizedQuestion" TEXT NOT NULL,
    "displayTitle" TEXT NOT NULL,
    "canonicalHash" TEXT NOT NULL,
    "clusterId" TEXT,
    "companyId" TEXT,
    "roleId" TEXT,
    "industry" TEXT,
    "questionType" "public"."QuestionBankQuestionType" NOT NULL,
    "difficulty" "public"."QuestionBankDifficulty" NOT NULL,
    "complexityScore" INTEGER NOT NULL,
    "technologies" TEXT[],
    "topics" TEXT[],
    "visibility" "public"."QuestionBankVisibility" NOT NULL DEFAULT 'PRIVATE',
    "visibilityClass" "public"."QuestionBankVisibilityClass" NOT NULL,
    "privacyRisk" "public"."QuestionBankPrivacyRisk" NOT NULL DEFAULT 'LOW',
    "moderationStatus" "public"."QuestionBankModerationStatus" NOT NULL DEFAULT 'PENDING',
    "sourceType" "public"."QuestionBankSourceType" NOT NULL,
    "frequencyCount" INTEGER NOT NULL DEFAULT 0,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "contributorCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answerGuide" JSONB,
    "answerGuideAvailable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuestionBankSource" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "clusterId" TEXT,
    "sourceUserId" TEXT,
    "sourceSessionId" TEXT,
    "sourceQaId" TEXT,
    "sourceType" "public"."QuestionBankSourceType" NOT NULL,
    "extractionConfidence" DOUBLE PRECISION NOT NULL,
    "sanitizerVersion" TEXT NOT NULL,
    "contributionOptIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionBankSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuestionBankSavedQuestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionBankSavedQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuestionBankExtractionRun" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "public"."QuestionBankExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "extractedCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionBankCompany_existingCompanyId_key" ON "public"."QuestionBankCompany"("existingCompanyId");
CREATE UNIQUE INDEX "QuestionBankCompany_slug_key" ON "public"."QuestionBankCompany"("slug");
CREATE INDEX "QuestionBankCompany_normalizedName_idx" ON "public"."QuestionBankCompany"("normalizedName");
CREATE INDEX "QuestionBankCompany_industry_idx" ON "public"."QuestionBankCompany"("industry");
CREATE UNIQUE INDEX "QuestionBankRole_slug_key" ON "public"."QuestionBankRole"("slug");
CREATE INDEX "QuestionBankRole_normalizedName_idx" ON "public"."QuestionBankRole"("normalizedName");
CREATE INDEX "QuestionBankRole_category_idx" ON "public"."QuestionBankRole"("category");
CREATE UNIQUE INDEX "QuestionBankTechnology_slug_key" ON "public"."QuestionBankTechnology"("slug");
CREATE INDEX "QuestionBankTechnology_category_idx" ON "public"."QuestionBankTechnology"("category");
CREATE UNIQUE INDEX "QuestionBankCluster_canonicalHash_key" ON "public"."QuestionBankCluster"("canonicalHash");
CREATE INDEX "QuestionBankCluster_companyId_idx" ON "public"."QuestionBankCluster"("companyId");
CREATE INDEX "QuestionBankCluster_roleId_idx" ON "public"."QuestionBankCluster"("roleId");
CREATE INDEX "QuestionBankCluster_publicEligible_idx" ON "public"."QuestionBankCluster"("publicEligible");
CREATE INDEX "QuestionBankCluster_updatedAt_idx" ON "public"."QuestionBankCluster"("updatedAt");
CREATE UNIQUE INDEX "QuestionBankQuestion_canonicalHash_companyId_roleId_key" ON "public"."QuestionBankQuestion"("canonicalHash", "companyId", "roleId");
CREATE INDEX "QuestionBankQuestion_clusterId_idx" ON "public"."QuestionBankQuestion"("clusterId");
CREATE INDEX "QuestionBankQuestion_companyId_idx" ON "public"."QuestionBankQuestion"("companyId");
CREATE INDEX "QuestionBankQuestion_roleId_idx" ON "public"."QuestionBankQuestion"("roleId");
CREATE INDEX "QuestionBankQuestion_visibility_moderationStatus_idx" ON "public"."QuestionBankQuestion"("visibility", "moderationStatus");
CREATE INDEX "QuestionBankQuestion_difficulty_idx" ON "public"."QuestionBankQuestion"("difficulty");
CREATE INDEX "QuestionBankQuestion_questionType_idx" ON "public"."QuestionBankQuestion"("questionType");
CREATE INDEX "QuestionBankQuestion_lastSeenAt_idx" ON "public"."QuestionBankQuestion"("lastSeenAt");
CREATE UNIQUE INDEX "QuestionBankSource_sourceKey_key" ON "public"."QuestionBankSource"("sourceKey");
CREATE INDEX "QuestionBankSource_questionId_idx" ON "public"."QuestionBankSource"("questionId");
CREATE INDEX "QuestionBankSource_clusterId_idx" ON "public"."QuestionBankSource"("clusterId");
CREATE INDEX "QuestionBankSource_sourceUserId_idx" ON "public"."QuestionBankSource"("sourceUserId");
CREATE INDEX "QuestionBankSource_sourceSessionId_idx" ON "public"."QuestionBankSource"("sourceSessionId");
CREATE INDEX "QuestionBankSource_sourceQaId_idx" ON "public"."QuestionBankSource"("sourceQaId");
CREATE INDEX "QuestionBankSource_contributionOptIn_idx" ON "public"."QuestionBankSource"("contributionOptIn");
CREATE UNIQUE INDEX "QuestionBankSavedQuestion_userId_questionId_key" ON "public"."QuestionBankSavedQuestion"("userId", "questionId");
CREATE INDEX "QuestionBankSavedQuestion_questionId_idx" ON "public"."QuestionBankSavedQuestion"("questionId");
CREATE UNIQUE INDEX "QuestionBankExtractionRun_sessionId_key" ON "public"."QuestionBankExtractionRun"("sessionId");
CREATE INDEX "QuestionBankExtractionRun_status_idx" ON "public"."QuestionBankExtractionRun"("status");
CREATE INDEX "QuestionBankExtractionRun_updatedAt_idx" ON "public"."QuestionBankExtractionRun"("updatedAt");
CREATE INDEX "Session_questionBankContributionOptIn_idx" ON "public"."Session"("questionBankContributionOptIn");

-- AddForeignKey
ALTER TABLE "public"."QuestionBankCompany" ADD CONSTRAINT "QuestionBankCompany_existingCompanyId_fkey" FOREIGN KEY ("existingCompanyId") REFERENCES "public"."Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankCluster" ADD CONSTRAINT "QuestionBankCluster_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."QuestionBankCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankCluster" ADD CONSTRAINT "QuestionBankCluster_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "public"."QuestionBankRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankQuestion" ADD CONSTRAINT "QuestionBankQuestion_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "public"."QuestionBankCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankQuestion" ADD CONSTRAINT "QuestionBankQuestion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."QuestionBankCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankQuestion" ADD CONSTRAINT "QuestionBankQuestion_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "public"."QuestionBankRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankSource" ADD CONSTRAINT "QuestionBankSource_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."QuestionBankQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankSource" ADD CONSTRAINT "QuestionBankSource_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "public"."QuestionBankCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankSource" ADD CONSTRAINT "QuestionBankSource_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankSource" ADD CONSTRAINT "QuestionBankSource_sourceSessionId_fkey" FOREIGN KEY ("sourceSessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankSource" ADD CONSTRAINT "QuestionBankSource_sourceQaId_fkey" FOREIGN KEY ("sourceQaId") REFERENCES "public"."QA"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankSavedQuestion" ADD CONSTRAINT "QuestionBankSavedQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankSavedQuestion" ADD CONSTRAINT "QuestionBankSavedQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."QuestionBankQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."QuestionBankExtractionRun" ADD CONSTRAINT "QuestionBankExtractionRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
