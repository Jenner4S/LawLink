-- 满意度评价补外键（2026-11-21）
--
-- 为什么补：报表口径要能**直接在 SQL 里叠加隔离墙**（access.matters）。
-- 没有关系字段时，只能把评价拉到内存再按案件过滤——量大时是全表扫描，
-- 且容易漏掉一条就让「被墙挡住案件的评价」出现在看板上。
--
-- 纯增量：只加两个外键约束，不改列、不动数据。
-- onDelete 策略：
--   · matterId → CASCADE：案件删了，针对它的评价也就没有对象了
--   · clientId → RESTRICT：与 PortalShare 一致，有评价的客户不能物理删
--     （客户本身是软删 deletedAt，不受影响）
--
-- 回滚：DROP CONSTRAINT 两条即可。
--
-- AddForeignKey
ALTER TABLE "PortalSatisfaction" ADD CONSTRAINT "PortalSatisfaction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSatisfaction" ADD CONSTRAINT "PortalSatisfaction_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

