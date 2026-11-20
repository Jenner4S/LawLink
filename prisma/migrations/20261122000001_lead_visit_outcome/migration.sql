-- 到店三态（2026-11-22，对标分析 P0-3）
--
-- 纯增量：1 个枚举 + 1 列（带默认值 PENDING，存量线索自动视为「未约定到店结果」）。
--
-- 为什么要这一列：客户现行系统里「到店来访」是状态单选（截图多行为「未曾来访」）。
-- 他区分「没约」与「约了没来」——那是两个完全不同的管理问题：
-- 没约是跟进没推进，爽约是邀约质量或客户意愿问题。
-- 现在只有 stage=INVITED，无法区分。
--
-- 为什么不新增 stage：「爽约」之后仍可再约，做成 stage 会在 INVITED↔NO_SHOW 之间跳，
-- 阶段漏斗就乱了。到店结果属于**一次邀约的事件属性**，不是阶段。
--
-- 回滚：DROP COLUMN + DROP TYPE；该列不参与任何唯一约束与业务计算（仅统计与提示）。
-- CreateEnum
CREATE TYPE "LeadVisitOutcome" AS ENUM ('PENDING', 'ARRIVED', 'NO_SHOW');

-- AlterEnum
ALTER TYPE "LeadActivityType" ADD VALUE 'NO_SHOW';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "visitOutcome" "LeadVisitOutcome" NOT NULL DEFAULT 'PENDING';

