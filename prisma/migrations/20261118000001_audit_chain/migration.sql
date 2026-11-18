-- 链式审计：给 AuditLog 加 SHA-256 链字段（借鉴 LexNebulis 的 nonrepudiation 设计）
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "integrityHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "previousHash" TEXT;
CREATE INDEX IF NOT EXISTS "AuditLog_previousHash_idx" ON "AuditLog"("previousHash");
