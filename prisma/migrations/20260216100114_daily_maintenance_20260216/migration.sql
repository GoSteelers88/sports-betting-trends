-- AlterTable
ALTER TABLE "FreeStat" ADD COLUMN "atsResult" TEXT;
ALTER TABLE "FreeStat" ADD COLUMN "autoBidStatus" TEXT;
ALTER TABLE "FreeStat" ADD COLUMN "bubbleStatus" TEXT;
ALTER TABLE "FreeStat" ADD COLUMN "completionEvidence" TEXT;
ALTER TABLE "FreeStat" ADD COLUMN "conference" TEXT;
ALTER TABLE "FreeStat" ADD COLUMN "gameStatus" TEXT;
ALTER TABLE "FreeStat" ADD COLUMN "opponentPoints" INTEGER;
ALTER TABLE "FreeStat" ADD COLUMN "opponentRank" INTEGER;
ALTER TABLE "FreeStat" ADD COLUMN "sourceEventId" TEXT;
ALTER TABLE "FreeStat" ADD COLUMN "spread" REAL;
ALTER TABLE "FreeStat" ADD COLUMN "teamRank" INTEGER;
ALTER TABLE "FreeStat" ADD COLUMN "won" BOOLEAN;

-- CreateIndex
CREATE INDEX "FreeStat_league_conference_idx" ON "FreeStat"("league", "conference");

-- CreateIndex
CREATE INDEX "FreeStat_team_gameDate_idx" ON "FreeStat"("team", "gameDate");
