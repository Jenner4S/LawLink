-- CreateEnum
CREATE TYPE "RateScope" AS ENUM ('DEFAULT', 'ROLE', 'USER', 'CLIENT', 'MATTER');

-- CreateEnum
CREATE TYPE "TimeEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'BILLED', 'WRITTEN_OFF');

-- CreateTable
CREATE TABLE "RateSchedule" (
    "id" TEXT NOT NULL,
    "scope" "RateScope" NOT NULL,
    "matterId" TEXT,
    "clientId" TEXT,
    "userId" TEXT,
    "role" "UserRole",
    "hourlyRate" DECIMAL(12,2) NOT NULL,
    "billingIncrement" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "narrative" TEXT NOT NULL,
    "taskCode" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "noChargeReason" TEXT,
    "rateScheduleId" TEXT,
    "hourlyRateSnapshot" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "billableMinutes" INTEGER NOT NULL,
    "billingId" TEXT,
    "status" "TimeEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateSchedule_scope_active_idx" ON "RateSchedule"("scope", "active");

-- CreateIndex
CREATE INDEX "RateSchedule_matterId_idx" ON "RateSchedule"("matterId");

-- CreateIndex
CREATE INDEX "RateSchedule_clientId_idx" ON "RateSchedule"("clientId");

-- CreateIndex
CREATE INDEX "RateSchedule_userId_idx" ON "RateSchedule"("userId");

-- CreateIndex
CREATE INDEX "TimeEntry_matterId_workDate_idx" ON "TimeEntry"("matterId", "workDate");

-- CreateIndex
CREATE INDEX "TimeEntry_userId_workDate_idx" ON "TimeEntry"("userId", "workDate");

-- CreateIndex
CREATE INDEX "TimeEntry_status_idx" ON "TimeEntry"("status");

-- CreateIndex
CREATE INDEX "TimeEntry_billingId_idx" ON "TimeEntry"("billingId");

-- AddForeignKey
ALTER TABLE "RateSchedule" ADD CONSTRAINT "RateSchedule_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateSchedule" ADD CONSTRAINT "RateSchedule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateSchedule" ADD CONSTRAINT "RateSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_rateScheduleId_fkey" FOREIGN KEY ("rateScheduleId") REFERENCES "RateSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_billingId_fkey" FOREIGN KEY ("billingId") REFERENCES "Billing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

