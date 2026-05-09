/**
 * ingest-nhl-model.ts — builds today's NHL win-probability model.
 *
 * Reads:
 *   data/processed/nhl-efficiency.json (team goal differentials; refreshed by ingest:nhl-efficiency)
 *   data/processed/latest-odds-api-icehockey_nhl.json (today's slate; refreshed by ingest:odds)
 * Writes:
 *   data/processed/nhl-model.json
 *
 * Run after `ingest:nhl-efficiency` and `ingest:odds`. The agent's
 * `get_model_probabilities` tool reads the output via the same path that
 * NBA / WNBA use (data.results[]).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHockeyModel,
  loadHockeyEfficiencyFile,
  loadGamesFromOddsFile,
  writeModelFile,
} from "../src/lib/hockey-model";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const processedDir = path.join(rootDir, "data", "processed");

const efficiencyPath = path.join(processedDir, "nhl-efficiency.json");
const oddsPath = path.join(processedDir, "latest-odds-api-icehockey_nhl.json");
const outPath = path.join(processedDir, "nhl-model.json");

if (!fs.existsSync(efficiencyPath)) {
  console.error(`[ingest-nhl-model] ${efficiencyPath} not found — run ingest:nhl-efficiency first`);
  process.exit(1);
}
if (!fs.existsSync(oddsPath)) {
  console.warn(`[ingest-nhl-model] ${oddsPath} not found — likely no NHL odds today, writing empty model`);
  const empty = {
    generatedAt: new Date().toISOString(),
    source: "nhl-efficiency-empirical",
    status: "no-games" as const,
    freshnessMins: 0,
    recordCount: 0,
    errors: [],
    data: {
      generatedAt: new Date().toISOString(),
      constants: { goalDiffToMargin: 0.5, homeIceBonus: 0.2, logisticSlope: 0.30 },
      teamCount: 0,
      gameCount: 0,
      results: [],
    },
  };
  fs.mkdirSync(processedDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(empty, null, 2), "utf-8");
  process.exit(0);
}

const efficiency = loadHockeyEfficiencyFile(efficiencyPath);
const games = loadGamesFromOddsFile(oddsPath);

const output = buildHockeyModel({
  source: "nhl-efficiency-empirical",
  games,
  efficiency,
});

writeModelFile(outPath, output);

if (output.recordCount === 0) {
  if (games.length === 0) {
    console.log("[ingest-nhl-model] No NHL games scheduled — wrote empty model");
  } else {
    console.warn(
      `[ingest-nhl-model] ${games.length} games scheduled but none matched efficiency data:\n  ` +
        output.errors.join("\n  "),
    );
  }
} else {
  console.log(
    `[ingest-nhl-model] Modeled ${output.recordCount}/${games.length} games. Wrote ${outPath}`,
  );
  for (const r of output.data.results) {
    const fav = r.homeWinProb >= 0.5 ? r.homeTeam : r.awayTeam;
    const favProb = r.homeWinProb >= 0.5 ? r.homeWinProb : r.awayWinProb;
    console.log(
      `  ${r.awayTeam} @ ${r.homeTeam} — ${fav} ${(favProb * 100).toFixed(1)}% (margin ${r.expectedMargin >= 0 ? "+" : ""}${r.expectedMargin.toFixed(2)} goals)`,
    );
  }
  if (output.errors.length > 0) {
    console.warn(`[ingest-nhl-model] ${output.errors.length} unmodeled games:`);
    for (const e of output.errors) console.warn(`  ${e}`);
  }
}
