-- CreateTable
CREATE TABLE "PositionDiscussionPost" (
    "id" SERIAL NOT NULL,
    "positionId" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionDiscussionPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PositionDiscussionPost_positionId_createdAt_idx" ON "PositionDiscussionPost"("positionId", "createdAt");

-- CreateIndex
CREATE INDEX "PositionDiscussionPost_authorId_idx" ON "PositionDiscussionPost"("authorId");

-- AddForeignKey
ALTER TABLE "PositionDiscussionPost" ADD CONSTRAINT "PositionDiscussionPost_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionDiscussionPost" ADD CONSTRAINT "PositionDiscussionPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
