-- CreateTable
CREATE TABLE "SessionNotes" (
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

-- CreateIndex
CREATE UNIQUE INDEX "SessionNotes_sessionId_key" ON "SessionNotes"("sessionId");

-- AddForeignKey
ALTER TABLE "SessionNotes" ADD CONSTRAINT "SessionNotes_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
