-- CreateTable
CREATE TABLE "JobPost" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "rawText" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "JobPost_url_key" ON "JobPost"("url");

-- CreateIndex
CREATE INDEX "JobPost_source_idx" ON "JobPost"("source");

-- CreateIndex
CREATE INDEX "JobPost_sentAt_idx" ON "JobPost"("sentAt");
