-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "aiUsage" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "simpleLanguage" SET DEFAULT true;
