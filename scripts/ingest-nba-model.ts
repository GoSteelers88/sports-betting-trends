/**
 * ingest-nba-model.ts — builds today's NBA win-probability model.
 *
 * Reads:
 *   data/processed/nba-efficiency.json (team net ratings; refreshed by ingest:nba-efficiency)
 *   data/processed/latest-odds-api-basketball_nba.json (today's slate; refreshed by ingest:odds)
 * Writes:
 *   data/processed/nba-model.json
 *
 * Run after `ingest:nba-efficiency` and `ingest:odds`. The agent's
 * `get_model_probabilities` tool reads the output.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBasketballModel,
  loadEfficiencyFile,
  loadGamesFromOddsFile,
  writeModelFile,
} from "../src/lib/basketball-model";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const processedDir = path.join(rootDir, "data", "processed");

const efficiencyPath = path.join(processedDir, "nba-efficiency.json");
const oddsPath = path.join(processedDir, "latest-odds-api-basketball_nba.json");
const outPath = path.join(processedDir, "nba-model.json");

if (!fs.existsSync(efficiencyPath)) {
  console.error(`[ingest-nba-model] ${efficiencyPath} not found — run ingest:nba-efficiency first`);
  process.exit(1);
}
if (!fs.existsSync(oddsPath)) {
  console.error(`[ingest-nba-model] ${oddsPath} not found — run ingest:odds first`);
  process.exit(1);
}

const efficiency = loadEfficiencyFile(efficiencyPath);
const games = loadGamesFromOddsFile(oddsPath);

const output = buildBasketballModel({
  source: "nba-efficiency-empirical",
  games,
  efficiency,
});

writeModelFile(outPath, output);

if (output.recordCount === 0) {
  if (games.length === 0) {
    console.log("[ingest-nba-model] No NBA games scheduled — wrote empty model");
  } else {
    console.warn(
      `[ingest-nba-model] ${games.length} games scheduled but none matched efficiency data:\n  ` +
        output.errors.join("\n  "),
    );
  }
} else {
  console.log(
    `[ingest-nba-model] Modeled ${output.recordCount}/${games.length} games. Wrote ${outPath}`,
  );
  for (const r of output.data.results) {
    const fav = r.homeWinProb >= 0.5 ? r.homeTeam : r.awayTeam;
    const favProb = r.homeWinProb >= 0.5 ? r.homeWinProb : r.awayWinProb;
    console.log(
      `  ${r.awayTeam} @ ${r.homeTeam} — ${fav} ${(favProb * 100).toFixed(1)}% (margin ${r.expectedMargin >= 0 ? "+" : ""}${r.expectedMargin.toFixed(1)})`,
    );
  }
  if (output.errors.length > 0) {
    console.warn(`[ingest-nba-model] ${output.errors.length} unmodeled games:`);
    for (const e of output.errors) console.warn(`  ${e}`);
  }
}
