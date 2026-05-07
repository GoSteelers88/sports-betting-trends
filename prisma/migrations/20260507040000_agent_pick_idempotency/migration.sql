-- CreateIndex
CREATE UNIQUE INDEX "AgentPick_league_gameDate_market_selection_key" ON "AgentPick"("league", "gameDate", "market", "selection");
