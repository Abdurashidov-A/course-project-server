-- CreateTable
CREATE TABLE "PositionOdooToken" (
    "id" TEXT NOT NULL,
    "positionId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionOdooToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PositionOdooToken_positionId_key" ON "PositionOdooToken"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "PositionOdooToken_tokenHash_key" ON "PositionOdooToken"("tokenHash");

-- AddForeignKey
ALTER TABLE "PositionOdooToken" ADD CONSTRAINT "PositionOdooToken_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionOdooToken" ADD CONSTRAINT "PositionOdooToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
