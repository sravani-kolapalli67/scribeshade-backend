-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PRE_CHECK', 'ACTIVE', 'PAUSED', 'COMPLETING', 'COMPLETED', 'ABANDONED', 'FORCE_ENDED', 'CREDIT_EXHAUSTED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('DEBIT', 'PURCHASE', 'REFUND', 'EARN');

-- CreateEnum
CREATE TYPE "DeductionReason" AS ENUM ('FREE_ZONE', 'HALF_BRACKET', 'FULL_BRACKET', 'EXHAUSTED', 'FORCE_ENDED', 'REFUND', 'BRACKET_OVERFLOW');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REFUNDED');

-- CreateTable
CREATE TABLE "CreditConfig" (
    "id" TEXT NOT NULL,
    "bracketMinutes" INTEGER NOT NULL,
    "creditsFull" DECIMAL(10,2) NOT NULL,
    "creditsHalf" DECIMAL(10,2) NOT NULL,
    "freeZoneMinutes" INTEGER NOT NULL DEFAULT 5,
    "graceZoneMinutes" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCreditBalance" (
    "userId" TEXT NOT NULL,
    "purchasedCredits" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "earnedCredits" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "heldCredits" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAvailable" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCreditBalance_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "type" "LedgerType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "balanceBefore" DECIMAL(10,2) NOT NULL,
    "balanceAfter" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packName" TEXT NOT NULL,
    "creditsPurchased" DECIMAL(10,2) NOT NULL,
    "creditsRemaining" DECIMAL(10,2) NOT NULL,
    "paymentProviderEventId" TEXT NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditConfig_bracketMinutes_key" ON "CreditConfig"("bracketMinutes");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_idx" ON "CreditLedger"("userId");

-- CreateIndex
CREATE INDEX "CreditLedger_sessionId_idx" ON "CreditLedger"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_paymentProviderEventId_key" ON "CreditPurchase"("paymentProviderEventId");

-- CreateIndex
CREATE INDEX "CreditPurchase_userId_idx" ON "CreditPurchase"("userId");

-- AddForeignKey
ALTER TABLE "UserCreditBalance" ADD CONSTRAINT "UserCreditBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
