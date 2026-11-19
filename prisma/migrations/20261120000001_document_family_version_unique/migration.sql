-- H1 修复：材料版本链的数据库级唯一性（2026-11-20）
--
-- 起因：多个并发「上传新版本」请求可以写出同一族里的两条同版本号记录，
-- 且两条都 isLatest=true（应用层先 updateMany 置 false，再 create 新的 true，
-- 两个事务交叉执行后各留一条 true）。版本链一旦分叉，历史回溯与归档快照
-- 都会取到不确定的那条。
--
-- 加唯一索引前已在主库与测试库核对过：现有数据 (familyId, version) 无重复组、
-- 每族至多一个 isLatest。若某个既有部署存在重复，本迁移会失败而不是静默改数据
-- ——那是正确的：先人工确认重复记录该保留哪条，再重跑迁移。
--
-- familyId 为 NULL 表示首版本（尚未成族），PG 唯一索引允许多 NULL，
-- 因此首版本不受影响。

CREATE UNIQUE INDEX "Document_familyId_version_key" ON "Document"("familyId", "version");
