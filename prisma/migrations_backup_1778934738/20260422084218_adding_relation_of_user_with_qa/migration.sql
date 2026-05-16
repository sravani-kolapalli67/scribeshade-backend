-- AlterTable
ALTER TABLE "QA" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "QA_userId_idx" ON "QA"("userId");

-- AddForeignKey
ALTER TABLE "QA" ADD CONSTRAINT "QA_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
