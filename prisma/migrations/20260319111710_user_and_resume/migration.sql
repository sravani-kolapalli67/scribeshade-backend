/*
  Warnings:

  - The primary key for the `Resume` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Made the column `email` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Resume" DROP CONSTRAINT "Resume_userId_fkey";

-- AlterTable
ALTER TABLE "Resume" DROP CONSTRAINT "Resume_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Resume_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Resume_id_seq";

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Resume" ADD CONSTRAINT "Resume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
