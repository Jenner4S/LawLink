-- 坏账逐笔冲抵明细（2026-11-22）
--
-- 纯增量：新表 + 外键。不改既有列、不动历史数据。
--
-- 为什么：一笔坏账常横跨多条应收条目（同一案分期 / 不同合同）。
-- 只记总额，对账时回答不了「这笔坏账冲的是哪几笔」，而律师对账问的正是这句。
--
-- 口径由服务层保证（明细合计 == 坏账总额；每条 <= 未收余额；只允许同案条目）：
-- 跨表等式用数据库触发器会引入难调试的隐式失败，放在应用层更可控。
--
-- 回滚：DROP TABLE（本迁移不写数据）。
-- CreateTable
CREATE TABLE "ReceivableWriteOffItem" (
    "id" TEXT NOT NULL,
    "writeOffId" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivableWriteOffItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceivableWriteOffItem_receivableId_idx" ON "ReceivableWriteOffItem"("receivableId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivableWriteOffItem_writeOffId_receivableId_key" ON "ReceivableWriteOffItem"("writeOffId", "receivableId");

-- AddForeignKey
ALTER TABLE "ReceivableWriteOffItem" ADD CONSTRAINT "ReceivableWriteOffItem_writeOffId_fkey" FOREIGN KEY ("writeOffId") REFERENCES "ReceivableWriteOff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivableWriteOffItem" ADD CONSTRAINT "ReceivableWriteOffItem_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "Receivable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

