-- 客户门户 S1：身份与邀请（2026-11-20）
--
-- 纯增量：只建两张新表 + 索引 + 外键，不动任何存量表与数据。
-- 设计依据：docs/客户门户架构方案-20261120.md §二（五个架构决策）、§三（数据模型草案）。
--
-- 为什么客户身份必须独立成表、不复用员工 User：
--   门户是本系统**第一次面向外网**。若客户与员工同表、仅靠 role 区分，
--   任何一处漏判 role 的查询都可能把客户当员工、或反过来。
--   结构性隔离（不同表 + 不同会话载体）让「客户不能调员工动作」由架构保证，
--   而不是由每处判断是否写对保证。
--
-- 关系与删除策略：
--   · ClientPortalUser.clientId → Client 用 RESTRICT：有门户账号的客户不能物理删除，
--     必须先停用账号（客户本身是软删 deletedAt，不受影响）。
--   · PortalInvite.portalUserId → ClientPortalUser 用 CASCADE：账号删了邀请自然无意义。
--   · PortalInvite.createdById 刻意**不建外键**：员工离职删号不应连带删除历史邀请记录
--     （邀请是留痕，不是业务数据）。
--
-- 回滚：整表 DROP 即可，无存量依赖。
--
-- CreateTable
CREATE TABLE "ClientPortalUser" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPortalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalInvite" (
    "id" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientPortalUser_email_key" ON "ClientPortalUser"("email");

-- CreateIndex
CREATE INDEX "ClientPortalUser_clientId_idx" ON "ClientPortalUser"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalInvite_tokenHash_key" ON "PortalInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "PortalInvite_portalUserId_idx" ON "PortalInvite"("portalUserId");

-- AddForeignKey
ALTER TABLE "ClientPortalUser" ADD CONSTRAINT "ClientPortalUser_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalInvite" ADD CONSTRAINT "PortalInvite_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "ClientPortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

