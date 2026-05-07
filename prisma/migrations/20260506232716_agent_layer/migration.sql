-- CreateTable
CREATE TABLE "AgentPick" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "gameDate" DATETIME NOT NULL,
    "matchup" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "oddsAmerican" INTEGER NOT NULL,
    "modelProb" REAL NOT NULL,
    "marketProb" REAL NOT NULL,
    "edge" REAL NOT NULL,
    "kellyStakeUnits" REAL NOT NULL,
    "confidence" INTEGER NOT NULL,
    "thesis" TEXT NOT NULL,
    "invalidation" TEXT NOT NULL,
    "signals" TEXT NOT NULL,
    "toolsUsed" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentOutcome" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pickId" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "actualOutcome" TEXT,
    "unitsPnl" REAL,
    "notes" TEXT,
    "gradedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentOutcome_pickId_fkey" FOREIGN KEY ("pickId") REFERENCES "AgentPick" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1.0,
    "evidence" TEXT NOT NULL,
    "supersedes" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentDreamRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "status" TEXT NOT NULL,
    "picksReviewed" INTEGER NOT NULL DEFAULT 0,
    "memoriesAdded" INTEGER NOT NULL DEFAULT 0,
    "memoriesRetired" INTEGER NOT NULL DEFAULT 0,
    "modelId" TEXT NOT NULL,
    "notes" TEXT,
    "error" TEXT
);

-- CreateIndex
CREATE INDEX "AgentPick_league_gameDate_idx" ON "AgentPick"("league", "gameDate");

-- CreateIndex
CREATE INDEX "AgentPick_runId_idx" ON "AgentPick"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOutcome_pickId_key" ON "AgentOutcome"("pickId");

-- CreateIndex
CREATE INDEX "AgentOutcome_result_idx" ON "AgentOutcome"("result");

-- CreateIndex
CREATE INDEX "AgentMemory_scope_active_idx" ON "AgentMemory"("scope", "active");

-- CreateIndex
CREATE INDEX "AgentMemory_type_active_idx" ON "AgentMemory"("type", "active");
