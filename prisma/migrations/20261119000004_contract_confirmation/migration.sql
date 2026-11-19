-- 台账 P1-4 降级实现：合同内容「阅知并确认」留痕（纯增量，无数据转换）
--
-- 备份：backups/pre-contract-confirmation-20261119.dump（docker exec lawlink-db pg_dump -Fc，450K）
--
-- 合规定位：本表只记录客户对某一版正文表示已阅知并确认（时间 / IP / UA / 正文哈希），
-- 不构成《电子签名法》意义上的电子签名，不能替代签字盖章。用途是证据链。
--
-- 设计要点：
--   1) contentSnapshot 存正文原文，contentHash 存其 SHA-256；展示与确认时都复核哈希，
--      有人直接改库里的快照就会对不上。
--   2) tokenHash 唯一：访问令牌 32 字节随机，明文只出现在发出的链接里，库中只有哈希。
--   3) engagementId / matterId 可空且 ON DELETE SET NULL——委托或案件被删（软删为主）
--      时确认留痕不随之消失；clientId 用 RESTRICT，客户是留痕的归属主体。
--   4) (status, expiresAt) 复合索引供 cron 过期清理扫描。

-- CreateEnum
CREATE TYPE "ConfirmationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "ContractConfirmation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "engagementId" TEXT,
    "matterId" TEXT,
    "contentSnapshot" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "ConfirmationStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMP(3),
    "confirmedIp" TEXT,
    "confirmedUa" TEXT,
    "confirmerName" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContractConfirmation_tokenHash_key" ON "ContractConfirmation"("tokenHash");

-- CreateIndex
CREATE INDEX "ContractConfirmation_clientId_status_idx" ON "ContractConfirmation"("clientId", "status");

-- CreateIndex
CREATE INDEX "ContractConfirmation_tokenHash_idx" ON "ContractConfirmation"("tokenHash");

-- CreateIndex
CREATE INDEX "ContractConfirmation_status_expiresAt_idx" ON "ContractConfirmation"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "ContractConfirmation" ADD CONSTRAINT "ContractConfirmation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractConfirmation" ADD CONSTRAINT "ContractConfirmation_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractConfirmation" ADD CONSTRAINT "ContractConfirmation_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractConfirmation" ADD CONSTRAINT "ContractConfirmation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
