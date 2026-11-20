-- 坏账登记（2026-11-22，对标分析 P0-5）
--
-- 纯增量：2 个枚举 + 1 张表 + 三处反向关系（不加列）。
--
-- 背景：客户现行系统有一列「退款及无法收取费用差额」，把退款与坏账合在一起。
-- LawLink 此前只有退款（Payment.refundedAmount），没有坏账——应收永远挂着，
-- 回款率到不了 100%，而没人知道差额是什么。
--
-- 为什么不直接改应收金额：
-- 应收是历史事实（合同签了多少），坏账是对事实的处置决定。
-- 把处置写进事实，就再也分不清「当初应收多少」与「后来免了多少」。
--
-- 生效条件：只有 APPROVED 才扣减未收余额；PENDING/REJECTED 一律不影响。
--
-- 回滚：DROP TABLE → DROP TYPE ×2。表为空时无数据损失。
-- CreateEnum
CREATE TYPE "WriteOffReason" AS ENUM ('CUSTOMER_UNREACHABLE', 'INABILITY_TO_PAY', 'WAIVED', 'IN_DISPUTE', 'OTHER');

-- CreateEnum
CREATE TYPE "WriteOffStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ReceivableWriteOff" (
    "id" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "billingId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" "WriteOffReason" NOT NULL DEFAULT 'OTHER',
    "note" TEXT,
    "status" "WriteOffStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceivableWriteOff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceivableWriteOff_matterId_status_idx" ON "ReceivableWriteOff"("matterId", "status");

-- CreateIndex
CREATE INDEX "ReceivableWriteOff_status_createdAt_idx" ON "ReceivableWriteOff"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_billingId_fkey" FOREIGN KEY ("billingId") REFERENCES "Billing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

