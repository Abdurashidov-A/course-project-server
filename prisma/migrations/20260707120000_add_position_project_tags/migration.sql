-- AlterTable
ALTER TABLE "Position" ADD COLUMN "projectTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
