-- 客户门户 S2：披露表（2026-11-20）
--
-- 纯增量：只建 enum + 一张新表 + 索引 + 外键，不动任何存量表与数据。
-- 设计依据：docs/客户门户架构方案-20261120.md §二 决策 2/3、§三 数据模型草案。
--
-- 铁律：**门户里不存在任何「自动可见」的路径。**
-- 没有 PortalShare 里的行，客户什么都看不到。要看，就必须有人点过「分享」，
-- 而这个动作留在审计里。一条带内部评估意见的案情分析发出去，可能直接输掉一个案子。
--
-- 撤销即软删（revokedAt / revokedById）：行保留，客户立即看不到，
-- 且能回答「什么时候撤的、谁撤的」——这正是硬删做不到的。
--
-- 外键：clientId → Client 用 RESTRICT（有披露记录的客户不能物理删）。
-- sharedById / revokedById 刻意**不建外键**：员工离职删号不应删除历史披露记录。
--
-- 回滚：整表 DROP 即可，无存量依赖。
--
-- CreateEnum
CREATE TYPE "PortalShareType" AS ENUM ('DOCUMENT', 'MATTER_SUMMARY', 'INVOICE', 'BILLING');

-- CreateTable
CREATE TABLE "PortalShare" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "shareType" "PortalShareType" NOT NULL,
    "documentId" TEXT,
    "matterId" TEXT,
    "invoiceId" TEXT,
    "sharedById" TEXT NOT NULL,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalShare_clientId_shareType_idx" ON "PortalShare"("clientId", "shareType");

-- CreateIndex
CREATE INDEX "PortalShare_clientId_revokedAt_idx" ON "PortalShare"("clientId", "revokedAt");

-- CreateIndex
CREATE INDEX "PortalShare_documentId_idx" ON "PortalShare"("documentId");

-- CreateIndex
CREATE INDEX "PortalShare_matterId_idx" ON "PortalShare"("matterId");

-- AddForeignKey
ALTER TABLE "PortalShare" ADD CONSTRAINT "PortalShare_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

