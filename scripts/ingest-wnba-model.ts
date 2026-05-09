/**
 * ingest-wnba-model.ts — builds today's WNBA win-probability model.
 *
 * Reads:
 *   data/processed/wnba-efficiency.json
 *   data/processed/latest-odds-api-basketball_wnba.json
 * Writes:
 *   data/processed/wnba-model.json
 *
 * Run after `ingest:wnba-efficiency` and `ingest:odds` (with WNBA configured
 * in THE_ODDS_LEAGUE for that ingest call).
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

const efficiencyPath = path.join(processedDir, "wnba-efficiency.json");
const oddsPath = path.join(processedDir, "latest-odds-api-basketball_wnba.json");
const outPath = path.join(processedDir, "wnba-model.json");

if (!fs.existsSync(efficiencyPath)) {
  console.error(`[ingest-wnba-model] ${efficiencyPath} not found — run ingest:wnba-efficiency first`);
  process.exit(1);
}
if (!fs.existsSync(oddsPath)) {
  console.warn(`[ingest-wnba-model] ${oddsPath} not found — likely no WNBA odds today, writing empty model`);
  const empty = {
    generatedAt: new Date().toISOString(),
    source: "wnba-efficiency-empirical",
    status: "no-games" as const,
    freshnessMins: 0,
    recordCount: 0,
    errors: [],
    data: {
      generatedAt: new Date().toISOString(),
      constants: { netRtgToPoints: 0.45, homeCourtBonus: 1.5, logisticSlope: 0.105 },
      teamCount: 0,
      gameCount: 0,
      results: [],
    },
  };
  fs.mkdirSync(processedDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(empty, null, 2), "utf-8");
  process.exit(0);
}

const efficiency = loadEfficiencyFile(efficiencyPath);
const games = loadGamesFromOddsFile(oddsPath);

const output = buildBasketballModel({
  source: "wnba-efficiency-empirical",
  games,
  efficiency,
});

writeModelFile(outPath, output);

if (output.recordCount === 0) {
  if (games.length === 0) {
    console.log("[ingest-wnba-model] No WNBA games scheduled — wrote empty model");
  } else {
    console.warn(
      `[ingest-wnba-model] ${games.length} games scheduled but none matched efficiency data:\n  ` +
        output.errors.join("\n  "),
    );
  }
} else {
  console.log(
    `[ingest-wnba-model] Modeled ${output.recordCount}/${games.length} games. Wrote ${outPath}`,
  );
  for (const r of output.data.results) {
    const fav = r.homeWinProb >= 0.5 ? r.homeTeam : r.awayTeam;
    const favProb = r.homeWinProb >= 0.5 ? r.homeWinProb : r.awayWinProb;
    console.log(
      `  ${r.awayTeam} @ ${r.homeTeam} — ${fav} ${(favProb * 100).toFixed(1)}% (margin ${r.expectedMargin >= 0 ? "+" : ""}${r.expectedMargin.toFixed(1)})`,
    );
  }
  if (output.errors.length > 0) {
    console.warn(`[ingest-wnba-model] ${output.errors.length} unmodeled games:`);
    for (const e of output.errors) console.warn(`  ${e}`);
  }
}
