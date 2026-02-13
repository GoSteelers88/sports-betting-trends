-- CreateTable
CREATE TABLE "FreeStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "league" TEXT NOT NULL,
    "gameDate" DATETIME NOT NULL,
    "team" TEXT NOT NULL,
    "opponent" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "rebounds" INTEGER,
    "assists" INTEGER,
    "yards" INTEGER,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "FreeStat_league_gameDate_idx" ON "FreeStat"("league", "gameDate");
