-- CreateTable
CREATE TABLE "CvLike" (
    "id" SERIAL NOT NULL,
    "cvId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CvLike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CvLike_cvId_userId_key" ON "CvLike"("cvId", "userId");

-- CreateIndex
CREATE INDEX "CvLike_cvId_idx" ON "CvLike"("cvId");

-- CreateIndex
CREATE INDEX "CvLike_userId_idx" ON "CvLike"("userId");

-- AddForeignKey
ALTER TABLE "CvLike" ADD CONSTRAINT "CvLike_cvId_fkey" FOREIGN KEY ("cvId") REFERENCES "Cv"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CvLike" ADD CONSTRAINT "CvLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
