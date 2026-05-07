-- CreateTable
CREATE TABLE "AgentRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "rawAnalystPicks" INTEGER NOT NULL,
    "graderKept" INTEGER NOT NULL,
    "criticKilled" INTEGER NOT NULL,
    "criticWeakened" INTEGER NOT NULL,
    "bankrollDropped" INTEGER NOT NULL,
    "finalPickCount" INTEGER NOT NULL,
    "totalUnits" REAL NOT NULL,
    "bankrollFlags" TEXT NOT NULL,
    "parseFailed" BOOLEAN NOT NULL DEFAULT false,
    "persistOk" BOOLEAN NOT NULL DEFAULT true,
    "modelId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_runId_key" ON "AgentRun"("runId");

-- CreateIndex
CREATE INDEX "AgentRun_league_createdAt_idx" ON "AgentRun"("league", "createdAt");
