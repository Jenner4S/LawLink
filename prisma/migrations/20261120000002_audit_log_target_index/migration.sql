-- A2 修复：按对象查审计的索引（2026-11-20）
--
-- approvals/history-access.ts:10 的审批历史权限判定，每次打开审批详情都执行：
--   where userId = ? AND targetId = ? AND targetType = ? AND action IN (...)
-- 现有索引 AuditLog_userId_createdAt_idx 只能命中 userId 前缀，
-- targetId/targetType 退化为 Filter，行数大时全表过滤。
--
-- 实测（合成 20 万条 AuditLog）：
--   加索引前 14.858 ms → 加 (targetId, targetType) 后 2.973 ms
--   该测量刻意用「userId 全相同」的最差选择性数据；真实环境 userId 分散，
--   优化器会直接走本索引，收益更明显。
--
-- 纯增量：不改变任何既有查询结果，只影响执行计划。

CREATE INDEX "AuditLog_targetId_targetType_idx" ON "AuditLog"("targetId", "targetType");
