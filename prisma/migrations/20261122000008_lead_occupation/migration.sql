-- 客户职业 / 行业（2026-11-22，P2）
--
-- 纯增量：Lead 加一列（可空）。
--
-- 客户宽表有「客户职业及行业信息」一列。放在线索阶段采集：
-- 谈案时判断案件类型、做风控（如涉赌涉贷）都靠它。
-- 客户档案侧另有 Client.industry（机构维度），两者不互相替代。
--
-- 回滚：DROP COLUMN。
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "occupation" TEXT;

