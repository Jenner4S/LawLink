-- 风险代理比例（2026-11-22，对标分析 P0-4）
--
-- 纯增量：Billing 加一列（可空）。
--
-- 背景：客户现行系统有「风代比例 / 风代金额」两列，而 LawLink 此前只有
-- Intake.contingencyTerms 一段自由文本——算不出、统计不了。
--
-- 设计取舍：**比例落库，金额不落库**。
-- 风代金额 = 实收 × 比例，随回款变化；落库金额必然与实收打架，
-- 而「两个数不一致」是财务上最难解释的一类问题。故金额按读时派生。
--
-- 回滚：DROP COLUMN；该列不参与任何约束与既有计算。
-- AlterTable
ALTER TABLE "Billing" ADD COLUMN     "contingencyPercent" DECIMAL(5,2);

