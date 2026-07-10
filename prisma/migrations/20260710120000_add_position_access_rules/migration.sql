-- CreateTable
CREATE TABLE "PositionAccessRule" (
    "id" SERIAL NOT NULL,
    "positionId" INTEGER NOT NULL,
    "attributeId" INTEGER NOT NULL,
    "operator" TEXT NOT NULL,
    "stringValue" TEXT,
    "numericValue" DOUBLE PRECISION,
    "booleanValue" BOOLEAN,
    "dateValue" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionAccessRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PositionAccessRule_positionId_idx" ON "PositionAccessRule"("positionId");

-- CreateIndex
CREATE INDEX "PositionAccessRule_attributeId_idx" ON "PositionAccessRule"("attributeId");

-- AddForeignKey
ALTER TABLE "PositionAccessRule" ADD CONSTRAINT "PositionAccessRule_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionAccessRule" ADD CONSTRAINT "PositionAccessRule_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
