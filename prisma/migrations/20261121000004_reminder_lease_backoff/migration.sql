-- 提醒投递：数据库级租约 + 持久退避（2026-11-21）
--
-- 纯增量：三列 + 两索引，不改列类型、不动数据、无数据转换。
-- 设计来源：docs/系统审计-20260921-第7轮v2.md「待审批：数据库级租约 + 持久退避」。
--
-- 解决两个具体问题（都不是理论风险）：
--   ① **多实例重复投递**：sweep 没有「领取」动作，行在处理期间仍是 PENDING。
--      进程内守卫 sweepInFlight 只防同进程重入；两个副本会同时捞到同一行各发一次。
--      唯一约束挡不住——它防的是「同键重复行」，不是「同一行重复发送」。
--      → leaseOwner + leaseUntil：领取成功才能发，租约过期可被其他实例接手（崩溃恢复）。
--   ② **失败退避缺失**：失败行 status 回 PENDING 且 registeredAt 不变（永远最早），
--      下一轮仍优先捞取，占满 take 窗口。09:00 全量补扫登记当日全部档位时叠加失败占位，
--      「今天到期」的提醒可能延迟数小时。
--      → nextAttemptAt：失败后按指数退避择时，正常行不再被失败行挤掉。
--
-- 回滚：DROP 两索引 + 三列即可；代码回退后这三列无人读写，无副作用。
--
-- AlterTable
ALTER TABLE "reminder_delivery" ADD COLUMN     "leaseOwner" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "reminder_delivery_status_next_attempt" ON "reminder_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "reminder_delivery_lease_until" ON "reminder_delivery"("leaseUntil");

