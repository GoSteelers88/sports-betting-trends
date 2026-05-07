-- CreateTable
CREATE TABLE "ModelPickSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "matchup" TEXT,
    "market" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "line" REAL,
    "oddsAmerican" INTEGER,
    "confidence" INTEGER,
    "edge" REAL,
    "rationaleSignals" TEXT NOT NULL,
    "player" TEXT,
    "team" TEXT,
    "opponent" TEXT,
    "propType" TEXT,
    "result" TEXT,
    "actualValue" REAL,
    "notes" TEXT,
    "gradedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ModelPickSnapshot_source_snapshotDate_idx" ON "ModelPickSnapshot"("source", "snapshotDate");

-- CreateIndex
CREATE INDEX "ModelPickSnapshot_league_result_idx" ON "ModelPickSnapshot"("league", "result");

-- CreateIndex
CREATE UNIQUE INDEX "ModelPickSnapshot_source_snapshotDate_market_selection_player_key" ON "ModelPickSnapshot"("source", "snapshotDate", "market", "selection", "player");
