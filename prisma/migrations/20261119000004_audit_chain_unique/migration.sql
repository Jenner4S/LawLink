-- DropIndex
DROP INDEX "AuditLog_previousHash_idx";

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_previousHash_key" ON "AuditLog"("previousHash");

