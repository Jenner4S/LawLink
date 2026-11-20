-- 客户门户 S3：工单与满意度（2026-11-21）
--
-- 纯增量：两个 enum、两张新表、给 ClientPortalUser 加一个带默认值的枚举列。
-- 不动任何存量表结构与数据（visibility 默认 ALL，与 S2 现状一致）。
--
-- 工单是客户**唯一能主动发起**的通道。三条设计约束：
--   ① 工单归属门户账号，同时冗余 clientId —— 跨客户隔离靠 clientId，
--      同一客户内协作者之间能否互见由 visibility 决定。
--   ② 回答不覆盖原内容：answerBody / answeredById / answeredAt 三者并列留痕。
--   ③ 满意度一案件一次（@@unique([clientId, matterId])），
--      匿名提交时 portalUserId 置空但保留 clientId —— 律所要知道是哪家客户，
--      但不知道是哪个人，这样"给差评会被认出来"的顾虑才真的被消解。
--      故 portalUserId 用 ON DELETE SET NULL 而非 CASCADE：
--      账号删除不应连带抹掉客户已经给出的评价。
--
-- 回滚：两张新表 DROP + DROP COLUMN visibility 即可，无存量依赖。
--
-- CreateEnum
CREATE TYPE "PortalCollaboratorVisibility" AS ENUM ('ALL', 'OWN_SUBMISSIONS');

-- CreateEnum
CREATE TYPE "PortalRequestStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');

-- AlterTable
ALTER TABLE "ClientPortalUser" ADD COLUMN     "visibility" "PortalCollaboratorVisibility" NOT NULL DEFAULT 'ALL';

-- CreateTable
CREATE TABLE "PortalRequest" (
    "id" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "PortalRequestStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answerBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSatisfaction" (
    "id" TEXT NOT NULL,
    "portalUserId" TEXT,
    "clientId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "npsScore" INTEGER,
    "comment" TEXT,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSatisfaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalRequest_status_dueAt_idx" ON "PortalRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "PortalRequest_clientId_createdAt_idx" ON "PortalRequest"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "PortalRequest_portalUserId_createdAt_idx" ON "PortalRequest"("portalUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PortalSatisfaction_clientId_createdAt_idx" ON "PortalSatisfaction"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "PortalSatisfaction_matterId_idx" ON "PortalSatisfaction"("matterId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSatisfaction_clientId_matterId_key" ON "PortalSatisfaction"("clientId", "matterId");

-- AddForeignKey
ALTER TABLE "PortalRequest" ADD CONSTRAINT "PortalRequest_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "ClientPortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSatisfaction" ADD CONSTRAINT "PortalSatisfaction_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "ClientPortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

