-- 工单到期提醒（2026-11-21，门户 S3 补）
--
-- 纯增量：给 ReminderDeliveryObjectType 加一个枚举值，不动表结构。
--
-- 为什么走提醒台账而不是直接在 submit 时发通知：
--   · 工单的提醒时间点在**未来**（dueAt），要么定时扫表、要么台账；
--   · 台账能回答「该发未发」——扫表方案答不了这个；
--   · 已有 registeredAt 支持未来档位（借阅 T-3 用过），复用它比自己写 cron 稳。
--
-- 回滚：Postgres 不支持删除枚举值；如需回滚，保持该值存在但不再登记即可
-- （代码回退后无人引用它，枚举多一个值无副作用）。
--
-- AlterEnum
ALTER TYPE "ReminderDeliveryObjectType" ADD VALUE 'PORTAL_REQUEST';

