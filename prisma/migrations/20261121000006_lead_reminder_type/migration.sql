-- 获客线索提醒（2026-11-21，全链路 阶段五）
--
-- 纯增量：枚举加一个值。不动任何表与数据。
-- 用途：约了到店时间没来 → 提醒跟进人（复用 ReminderDelivery 台账，
-- 这样「该发未发」能查到，而不是只记成功了哪些）。
--
-- 回滚：Postgres 不支持删除枚举值；回滚方式是不再写入该类型（投递器对
-- 未知类型已做防御性 SKIPPED）。这是本迁移唯一的不可逆点，写在这里备查。
-- AlterEnum
ALTER TYPE "ReminderDeliveryObjectType" ADD VALUE 'LEAD';

