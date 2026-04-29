/**
 * ingest-mlb-model.ts — runs the MLB win-probability model pipeline.
 * Builds feature vectors from pitcher/bullpen/standings data, calls Python sidecar,
 * writes data/processed/mlb-model-output.json.
 *
 * Run after ingest:mlb-pitchers and ingest:mlb-bullpen.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMlbModel } from "../src/lib/mlb-model";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load today's games from pitcher data (has all scheduled games)
const pitcherPath = path.join(rootDir, "data/processed/mlb-pitchers-today.json");
if (!fs.existsSync(pitcherPath)) {
  console.error("[ingest-mlb-model] mlb-pitchers-today.json not found — run ingest:mlb-pitchers first");
  process.exit(1);
}

const pitcherData = JSON.parse(fs.readFileSync(pitcherPath, "utf-8")) as {
  games: Array<{ eventId: string; homeTeam: string; awayTeam: string }>;
};

const games = pitcherData.games.map((g) => ({
  eventId: g.eventId,
  homeTeam: g.homeTeam,
  awayTeam: g.awayTeam,
  commenceTimeMs: Date.now(), // not critical for feature building
}));

if (games.length === 0) {
  console.log("[ingest-mlb-model] No games today.");
  process.exit(0);
}

const output = runMlbModel(games, rootDir);

if (output.results.length === 0) {
  console.log("[ingest-mlb-model] No games modeled.");
} else {
  const calibrated = output.results.filter((r) => r.calibrated).length;
  console.log(
    `[ingest-mlb-model] ${output.results.length} games modeled, ${calibrated} calibrated. ` +
      `Wrote mlb-model-output.json`
  );
  for (const r of output.results) {
    const hp = r.homePitcherName ? ` (SP: ${r.homePitcherName})` : "";
    const ap = r.awayPitcherName ? ` (SP: ${r.awayPitcherName})` : "";
    console.log(
      `  ${r.awayTeam}${ap} @ ${r.homeTeam}${hp} — home win prob: ${(r.homeWinProb * 100).toFixed(1)}%`
    );
  }
}
