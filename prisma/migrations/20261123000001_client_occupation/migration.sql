-- 客户职业（2026-11-23）
--
-- 纯增量：Client 加一列（可空）。
--
-- 线索阶段已在 Lead.occupation 采集职业；收案转案件建客户时自动继承，
-- 避免二次录入。与 Client.industry（机构/行业）并存：
-- 个人客户常只有职业、没有行业。
--
-- 回滚：DROP COLUMN。
-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "occupation" TEXT;

