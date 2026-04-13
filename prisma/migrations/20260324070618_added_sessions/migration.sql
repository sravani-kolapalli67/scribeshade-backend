-- CreateTable
CREATE TABLE "Sessions" (
    "id" TEXT NOT NULL,
    "autoGenerate" BOOLEAN NOT NULL,
    "description" TEXT NOT NULL,
    "extraContext" TEXT NOT NULL,
    "free" BOOLEAN NOT NULL,
    "language" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "saveTranscription" BOOLEAN NOT NULL,
    "simpleLanguage" BOOLEAN NOT NULL,
    "title" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sessions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Sessions" ADD CONSTRAINT "Sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
