/*
  Warnings:

  - You are about to drop the column `autoGenerate` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the `Templates` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `DocumentId` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `autoGenerateResponse` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `company` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `jobDescription` to the `Session` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Session" DROP COLUMN "autoGenerate",
DROP COLUMN "description",
DROP COLUMN "title",
ADD COLUMN     "DocumentId" TEXT NOT NULL,
ADD COLUMN     "autoGenerateResponse" BOOLEAN NOT NULL,
ADD COLUMN     "company" TEXT NOT NULL,
ADD COLUMN     "jobDescription" TEXT NOT NULL;

-- DropTable
DROP TABLE "Templates";

-- CreateTable
CREATE TABLE "ResumeTemplate" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeTemplate_pkey" PRIMARY KEY ("id")
);
