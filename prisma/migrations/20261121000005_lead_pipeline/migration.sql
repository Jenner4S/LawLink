-- 获客 → 邀约 → 到店谈案（2026-11-21，全链路数字化 阶段 1）
--
-- 纯增量：三个枚举 + 两张新表 + Intake 一条反向关系（不加列）。
--
-- 为什么线索不复用 Intake：
--   Intake 是「已决定接案」之后的登记（走冲突检索与审批）。线索阶段大量是
--   「问一句就走」，塞进 Intake 会让收案列表被噪声污染，也算不出转化率——
--   而转化率正是获客要回答的唯一问题。
--
-- 回滚：DROP 两表 + 三个枚举即可，Intake 侧无新增列，无数据转换。
--
-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('LEAD', 'INVITED', 'VISITED', 'CONSULTED', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('REFERRAL', 'ONLINE', 'OFFLINE', 'PARTNER', 'AD', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('CONTACT', 'INVITE', 'VISIT', 'CONSULT', 'NOTE');

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "wechat" TEXT,
    "organization" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "sourceDetail" TEXT,
    "stage" "LeadStage" NOT NULL DEFAULT 'LEAD',
    "category" "MatterCategory" NOT NULL DEFAULT 'CIVIL_COMMERCIAL',
    "expectedAmount" DECIMAL(14,2),
    "ownerId" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3),
    "visitedAt" TIMESTAMP(3),
    "consultedAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "lostAt" TIMESTAMP(3),
    "convertedIntakeId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadActivity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "happenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_convertedIntakeId_key" ON "Lead"("convertedIntakeId");

-- CreateIndex
CREATE INDEX "Lead_stage_createdAt_idx" ON "Lead"("stage", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_ownerId_stage_idx" ON "Lead"("ownerId", "stage");

-- CreateIndex
CREATE INDEX "Lead_source_idx" ON "Lead"("source");

-- CreateIndex
CREATE INDEX "LeadActivity_leadId_happenedAt_idx" ON "LeadActivity"("leadId", "happenedAt");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedIntakeId_fkey" FOREIGN KEY ("convertedIntakeId") REFERENCES "Intake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

