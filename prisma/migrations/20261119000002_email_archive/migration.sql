-- CreateEnum
CREATE TYPE "EmailMatchKind" AS ENUM ('MATCHED_BY_CODE', 'MATCHED_BY_PARTY', 'MATCHED_BY_ADDRESS', 'MANUAL', 'UNMATCHED');

-- CreateTable
CREATE TABLE "EmailArchive" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "sentAt" TIMESTAMP(3) NOT NULL,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "matterId" TEXT,
    "matchKind" "EmailMatchKind" NOT NULL DEFAULT 'UNMATCHED',
    "matchEvidence" TEXT,
    "archivedById" TEXT NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailArchive_messageId_key" ON "EmailArchive"("messageId");

-- CreateIndex
CREATE INDEX "EmailArchive_matterId_sentAt_idx" ON "EmailArchive"("matterId", "sentAt");

-- CreateIndex
CREATE INDEX "EmailArchive_matchKind_sentAt_idx" ON "EmailArchive"("matchKind", "sentAt");

-- CreateIndex
CREATE INDEX "EmailArchive_fromAddress_idx" ON "EmailArchive"("fromAddress");

-- AddForeignKey
ALTER TABLE "EmailArchive" ADD CONSTRAINT "EmailArchive_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailArchive" ADD CONSTRAINT "EmailArchive_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

