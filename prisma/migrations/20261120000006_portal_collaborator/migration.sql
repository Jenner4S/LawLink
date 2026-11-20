-- 门户协作者（2026-11-20，方案 §七 Q3）
--
-- 纯增量：给 ClientPortalUser 加一个带默认值的布尔列，不动存量行、不改其他表。
-- 存量账号默认 true（它们本来就是一客户一账号，天然是主账号）——
-- 这正是 @default(true) 的意义：迁移不动任何既有语义。
--
-- 为什么只加这一列，不加「协作者可见性两档」枚举：
-- 「仅自己提交的」这一档的作用对象是**工单**（PortalRequest），而工单在 S3 才落地。
-- 现在引入一个没有作用对象的开关，就是假功能（UI 上能切、切了没有任何效果）。
-- 等 S3 的 PortalRequest 建好，再加 visibility 列并把档位接进工单查询。
--
-- 回滚：DROP COLUMN 即可，无存量依赖。
--
-- AlterTable
ALTER TABLE "ClientPortalUser" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT true;

