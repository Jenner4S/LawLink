-- 获客渠道两级 + 券金额（2026-11-22，对标分析 P0-1）
--
-- 纯增量：1 个枚举 + 1 张表 + Lead 两列（均可空，不动存量）。
--
-- 为什么要独立表：客户现行系统里「渠道/二级渠道」是**单选**（本地生活/大众点评），
-- 单选才能聚合出「大众点评这个月来 40 条、成交 3 单」。此前只有固定枚举 +
-- sourceDetail 自由文本，导不出按平台 ROI。
--
-- 回滚：DROP 两列 → DROP TABLE "LeadChannel" → DROP TYPE "LeadChannelKind"。
-- 存量 Lead.channelId 为空时聚合回退 source 枚举，不产生错误统计。
-- CreateEnum
CREATE TYPE "LeadChannelKind" AS ENUM ('PAID', 'ORGANIC', 'REFERRAL', 'PARTNER', 'OTHER');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "channelId" TEXT,
ADD COLUMN     "voucherAmount" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "LeadChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" "LeadChannelKind" NOT NULL DEFAULT 'OTHER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadChannel_parentId_active_sort_idx" ON "LeadChannel"("parentId", "active", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "LeadChannel_parentId_name_key" ON "LeadChannel"("parentId", "name");

-- AddForeignKey
ALTER TABLE "LeadChannel" ADD CONSTRAINT "LeadChannel_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LeadChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "LeadChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

