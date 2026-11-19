-- 续保记录补单位列（2026-11-19）
-- 背景：此前只有 renewalDuration（天数），「续保一年」被记成「续保 365 天」，
-- 而闰年 365 天 ≠ 一年（2027-06-15 + 365 天 = 2028-06-14，法定应为 2028-06-15）。
-- 单位决定日期算法，也是台账可读性的依据。
--
-- 注意：本文件初次生成时为 0 字节（prisma migrate diff 在该时点未产出差异），
-- 但迁移已被登记为 applied，导致主库缺列、保全列表与续保在运行时 500。
-- 现已补上 ALTER；因记录已存在，需要先清记录再重放（或直接执行本 ALTER）。
ALTER TABLE "PreservationPropertyRenewal"
  ADD COLUMN "renewalUnit" "DeadlinePeriodUnit" NOT NULL DEFAULT 'DAYS';
