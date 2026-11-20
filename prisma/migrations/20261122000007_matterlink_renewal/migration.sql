-- 续案 / 二次委托（2026-11-22，P2）
--
-- 只给既有枚举加一个值：MatterLink 已能表达有向关联，再加 parentMatterId 会让
-- "同一关系存两处"，必然出现不一致。
--
-- 客户现行系统用「父记录字段」表达"同一客户再次委托"，并统计「委托次数」。
-- RELATED_CASE 只说明"两件有关联"，说不清谁是主案、谁是后续；
-- 而续案的价值在"第 N 次委托"这个序次上。
--
-- 不可逆说明：Postgres 不支持删除枚举值。回滚 = 停止写入 RENEWAL
-- （存量行改回 RELATED_CASE 后再重建类型；本迁移不写入任何数据）。
-- AlterEnum
ALTER TYPE "MatterLinkRelation" ADD VALUE 'RENEWAL';

