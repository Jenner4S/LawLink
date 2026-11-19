-- CreateEnum
CREATE TYPE "EthicalWallTargetType" AS ENUM ('USER', 'TEAM', 'ROLE');

-- CreateTable
CREATE TABLE "EthicalWall" (
    "id" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "liftReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EthicalWall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EthicalWallDenial" (
    "id" TEXT NOT NULL,
    "wallId" TEXT NOT NULL,
    "denyType" "EthicalWallTargetType" NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "role" "UserRole",

    CONSTRAINT "EthicalWallDenial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EthicalWall_matterId_active_idx" ON "EthicalWall"("matterId", "active");

-- CreateIndex
CREATE INDEX "EthicalWall_active_expiresAt_idx" ON "EthicalWall"("active", "expiresAt");

-- CreateIndex
CREATE INDEX "EthicalWallDenial_wallId_idx" ON "EthicalWallDenial"("wallId");

-- CreateIndex
CREATE INDEX "EthicalWallDenial_userId_idx" ON "EthicalWallDenial"("userId");

-- CreateIndex
CREATE INDEX "EthicalWallDenial_teamId_idx" ON "EthicalWallDenial"("teamId");

-- AddForeignKey
ALTER TABLE "EthicalWall" ADD CONSTRAINT "EthicalWall_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicalWall" ADD CONSTRAINT "EthicalWall_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicalWall" ADD CONSTRAINT "EthicalWall_liftedById_fkey" FOREIGN KEY ("liftedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicalWallDenial" ADD CONSTRAINT "EthicalWallDenial_wallId_fkey" FOREIGN KEY ("wallId") REFERENCES "EthicalWall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicalWallDenial" ADD CONSTRAINT "EthicalWallDenial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicalWallDenial" ADD CONSTRAINT "EthicalWallDenial_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

