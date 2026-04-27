/*
  Warnings:

  - You are about to drop the `Transcript` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Transcript" DROP CONSTRAINT "Transcript_sessionId_fkey";

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "transcript" JSONB NOT NULL DEFAULT '[]';

-- DropTable
DROP TABLE "Transcript";
