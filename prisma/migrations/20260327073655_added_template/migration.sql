-- CreateTable
CREATE TABLE "Templates" (
    "id" TEXT NOT NULL,
    "categrory" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Templates_pkey" PRIMARY KEY ("id")
);
