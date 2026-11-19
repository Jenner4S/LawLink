-- 台账 P2-2 后半：WebAuthn / Passkey（纯增量，无数据转换）
--
-- 备份：backups/pre-webauthn-20261119.dump（pg_dump -Fc，444K）
-- 说明：
--   1) WebAuthnChallenge.challenge 唯一 —— 挑战必须全局唯一，重复即拒绝写入（防跨用户复用）。
--   2) WebAuthnChallenge 同表承载一次性登录票据（kind = TICKET / TICKET_2FA）：
--      票据的"用后即焚"依赖 UpdateMany 的条件更新，放进程内 Map 在多实例部署下会
--      出现"发票据在 A 实例、核销在 B 实例"，与 challenge 同一类问题。
--   3) WebAuthnCredential.counter 用 BIGINT：认证器 counter 为 32 位无符号，
--      Prisma Int 是有符号 32 位，越界（>2147483647）会写入失败。
--   4) credentialId 唯一：同一认证器不可被两个账号绑定（防注册重放）。

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceName" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_userId_idx" ON "WebAuthnCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON "WebAuthnChallenge"("challenge");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_expiresAt_idx" ON "WebAuthnChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
