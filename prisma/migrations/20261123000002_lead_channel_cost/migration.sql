-- 渠道月度投放成本（2026-11-23）
--
-- 纯增量：新表。
--
-- 线索上的 voucherAmount 是"每条线索的券金额"，不等于"这个月在某渠道投了 3000"。
-- 没有渠道级投放成本，漏斗里单线索/单到店/单成交成本就没有可信来源，
-- 业主只能改库 —— 等于那几列没做完。
--
-- 口径：渠道 × 月唯一（month 形如 2026-11），重复录入是覆盖不是累加。
--
-- 回滚：DROP TABLE。
-- CreateTable
CREATE TABLE "LeadChannelCost" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadChannelCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadChannelCost_month_idx" ON "LeadChannelCost"("month");

-- CreateIndex
CREATE UNIQUE INDEX "LeadChannelCost_channelId_month_key" ON "LeadChannelCost"("channelId", "month");

-- AddForeignKey
ALTER TABLE "LeadChannelCost" ADD CONSTRAINT "LeadChannelCost_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "LeadChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

