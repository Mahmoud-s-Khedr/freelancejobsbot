-- AlterTable
ALTER TABLE "TelegramQueue" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "TelegramQueue" ADD COLUMN "leaseUntil" DATETIME;

-- CreateTable
CREATE TABLE "CollectionSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baselineAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "cooldownUntil" DATETIME,
    "leaseToken" TEXT,
    "leaseUntil" DATETIME
);

-- CreateTable
CREATE TABLE "CollectionRun" (
    "leaseToken" TEXT NOT NULL,
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL,
    "errors" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "JobVersion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobPostId" INTEGER NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    CONSTRAINT "JobVersion_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobSighting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobPostId" INTEGER NOT NULL,
    "runId" INTEGER NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobSighting_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JobSighting_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CollectionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AlertIdentity" (
    "url" TEXT NOT NULL PRIMARY KEY,
    "jobPostId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RequestHost" (
    "host" TEXT NOT NULL PRIMARY KEY,
    "nextRequestAt" DATETIME NOT NULL,
    "cooldownUntil" DATETIME
);

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
    "updatedAt" DATETIME NOT NULL,
    "applicationUrl" TEXT,
    "employer" TEXT,
    "listingKind" TEXT NOT NULL DEFAULT 'marketplace',
    "locations" TEXT,
    "workplaceModel" TEXT,
    "geographicRestrictions" TEXT,
    "employmentType" TEXT,
    "seniority" TEXT,
    "compensationCurrency" TEXT,
    "compensationPeriod" TEXT,
    "sourceUpdatedAt" DATETIME,
    "timestampSemantics" TEXT NOT NULL DEFAULT 'legacy-imported',
    "qualityEvidence" TEXT,
    "missingFromSourceAt" DATETIME
);
INSERT INTO "new_JobPost" ("budgetMax", "budgetMin", "budgetText", "category", "contentHash", "createdAt", "description", "durationText", "id", "lastSeenAt", "publishedAt", "rawText", "sentAt", "skills", "source", "sourceProjectId", "status", "title", "updatedAt", "url") SELECT "budgetMax", "budgetMin", "budgetText", "category", "contentHash", "createdAt", "description", "durationText", "id", "lastSeenAt", "publishedAt", "rawText", "sentAt", "skills", "source", "sourceProjectId", "status", "title", "updatedAt", "url" FROM "JobPost";
DROP TABLE "JobPost";
ALTER TABLE "new_JobPost" RENAME TO "JobPost";
CREATE INDEX "JobPost_source_idx" ON "JobPost"("source");
CREATE INDEX "JobPost_sentAt_idx" ON "JobPost"("sentAt");
CREATE INDEX "JobPost_lastSeenAt_idx" ON "JobPost"("lastSeenAt");
CREATE UNIQUE INDEX "JobPost_source_sourceProjectId_key" ON "JobPost"("source", "sourceProjectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRun_leaseToken_key" ON "CollectionRun"("leaseToken");

-- CreateIndex
CREATE INDEX "JobVersion_jobPostId_hash_idx" ON "JobVersion"("jobPostId", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "JobSighting_jobPostId_runId_key" ON "JobSighting"("jobPostId", "runId");


UPDATE JobPost SET qualityEvidence = CASE WHEN source = 'nafezly' THEN 'legacy imported; publishedAt may be discovery time' ELSE 'legacy imported; timestamp provenance unverified' END;
INSERT INTO JobVersion(jobPostId, observedAt, hash, content) SELECT id, createdAt, 'legacy-' || id, json_object('source',source,'sourceProjectId',sourceProjectId,'title',title,'url',url,'description',description,'publishedAt',publishedAt,'budgetMin',budgetMin,'budgetMax',budgetMax,'rawText',rawText,'category',category,'status',status,'budgetText',budgetText,'durationText',durationText,'skills',skills,'createdAt',createdAt,'updatedAt',updatedAt) FROM JobPost;
INSERT OR IGNORE INTO AlertIdentity(url,jobPostId,createdAt) SELECT url,id,createdAt FROM JobPost WHERE sentAt IS NOT NULL OR id IN (SELECT jobPostId FROM TelegramQueue);

