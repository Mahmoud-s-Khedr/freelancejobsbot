/*
  Warnings:

  - Added the required column `sourceProjectId` to the `JobPost` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_JobPost" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "sourceProjectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "rawText" TEXT,
    "category" TEXT,
    "status" TEXT,
    "publishedAt" DATETIME,
    "budgetMin" INTEGER,
    "budgetMax" INTEGER,
    "budgetText" TEXT,
    "durationText" TEXT,
    "skills" TEXT,
    "lastSeenAt" DATETIME,
    "contentHash" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_JobPost" (
    "createdAt",
    "description",
    "id",
    "rawText",
    "sentAt",
    "source",
    "sourceProjectId",
    "title",
    "updatedAt",
    "url"
)
SELECT
    "createdAt",
    "description",
    "id",
    "rawText",
    "sentAt",
    "source",
    CASE
        WHEN "source" = 'mostaql' AND "url" LIKE 'https://mostaql.com/project/%' THEN
            CASE
                WHEN instr(substr("url", length('https://mostaql.com/project/') + 1), '-') > 0 THEN
                    substr(
                        substr("url", length('https://mostaql.com/project/') + 1),
                        1,
                        instr(substr("url", length('https://mostaql.com/project/') + 1), '-') - 1
                    )
                ELSE
                    substr("url", length('https://mostaql.com/project/') + 1)
            END
        ELSE "url"
    END,
    "title",
    "updatedAt",
    "url"
FROM "JobPost";
DROP TABLE "JobPost";
ALTER TABLE "new_JobPost" RENAME TO "JobPost";
CREATE UNIQUE INDEX "JobPost_url_key" ON "JobPost"("url");
CREATE INDEX "JobPost_source_idx" ON "JobPost"("source");
CREATE INDEX "JobPost_sentAt_idx" ON "JobPost"("sentAt");
CREATE INDEX "JobPost_lastSeenAt_idx" ON "JobPost"("lastSeenAt");
CREATE UNIQUE INDEX "JobPost_source_sourceProjectId_key" ON "JobPost"("source", "sourceProjectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
