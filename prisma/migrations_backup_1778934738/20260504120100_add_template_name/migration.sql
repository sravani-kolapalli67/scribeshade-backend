-- Add name column to ResumeTemplate (nullable first, then set default, then NOT NULL)
ALTER TABLE "ResumeTemplate" ADD COLUMN "name" TEXT;
UPDATE "ResumeTemplate" SET "name" = "category" WHERE "name" IS NULL;
ALTER TABLE "ResumeTemplate" ALTER COLUMN "name" SET NOT NULL;
