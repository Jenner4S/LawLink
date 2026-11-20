-- 对接律师 / 接单状态 / 二次对接人（2026-11-22，P1-2 + P1-3）
--
-- 纯增量：1 个枚举 + Lead 六列（均可空或有默认）。
--
-- 客户现行系统有三列：「对接律师」「对接律师状态」「二次对接人」。
-- 前者回答「派给谁谈」，状态回答「派了之后律师接不接」——
-- 不记录这个，"派了但没人跟"的线索会沉在库里没人发现。
--
-- assigneeNote 与 lostReason 分开存：lostReason 是客户流失，assigneeNote 是内部派单结果
-- （拒接/暂忙），混在一起会让流失统计失真。
--
-- 回滚：DROP 六列 → DROP TYPE。新增列均可空，存量线索自动为"未指派/无二次对接人"。
-- CreateEnum
CREATE TYPE "LeadAssigneeStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'ACCEPTED', 'DECLINED', 'BUSY');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "assigneeLawyerId" TEXT,
ADD COLUMN     "assigneeNote" TEXT,
ADD COLUMN     "assigneeStatus" "LeadAssigneeStatus" NOT NULL DEFAULT 'UNASSIGNED',
ADD COLUMN     "handoverAt" TIMESTAMP(3),
ADD COLUMN     "secondOwnerId" TEXT;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assigneeLawyerId_fkey" FOREIGN KEY ("assigneeLawyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_secondOwnerId_fkey" FOREIGN KEY ("secondOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

