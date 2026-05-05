-- CreateTable
CREATE TABLE "BuiltResume" (
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

    CONSTRAINT "BuiltResume_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuiltResume_userId_idx" ON "BuiltResume"("userId");

-- AddForeignKey
ALTER TABLE "BuiltResume" ADD CONSTRAINT "BuiltResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
