-- CreateTable
CREATE TABLE "TelegramQueue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobPostId" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramQueue_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramQueue_jobPostId_key" ON "TelegramQueue"("jobPostId");
