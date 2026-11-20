-- 分成角色（2026-11-22，D 段）
--
-- 纯增量：1 个枚举 + CommissionPlan.role（可空）。
--
-- 客户现行系统把功劳拆给三个人：案源人 / 邀约人 / 面谈签约人 —— 三笔绩效。
-- 此前 label 是自由文本，能写但统计不了（按字符串匹配"邀约"/"约人"必然出错）。
-- 加结构化 role 后可按角色汇总提成；label 保留为补充说明。
--
-- 存量数据 role 为 NULL，等同于"未标注角色"，不进入按角色统计（不会误计入）。
--
-- 回滚：DROP COLUMN → DROP TYPE。
-- CreateEnum
CREATE TYPE "CommissionRole" AS ENUM ('REFERRER', 'INVITER', 'CLOSER', 'OTHER');

-- AlterTable
ALTER TABLE "CommissionPlan" ADD COLUMN     "role" "CommissionRole";

