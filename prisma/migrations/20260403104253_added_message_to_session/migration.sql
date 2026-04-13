-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "messages" JSONB NOT NULL DEFAULT '[]';
