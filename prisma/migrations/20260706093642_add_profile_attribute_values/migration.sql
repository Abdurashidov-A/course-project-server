-- CreateTable
CREATE TABLE "ProfileAttributeValue" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "attributeId" INTEGER NOT NULL,
    "stringValue" TEXT,
    "textValue" TEXT,
    "numericValue" DOUBLE PRECISION,
    "booleanValue" BOOLEAN,
    "dateValue" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "imageUrl" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileAttributeValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileAttributeValue_userId_attributeId_key" ON "ProfileAttributeValue"("userId", "attributeId");

-- AddForeignKey
ALTER TABLE "ProfileAttributeValue" ADD CONSTRAINT "ProfileAttributeValue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileAttributeValue" ADD CONSTRAINT "ProfileAttributeValue_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
