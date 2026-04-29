/**
 * ingest-mlb-bullpen.ts
 * Computes bullpen fatigue and ERA per team from already-fetched
 * data/raw/mlb/latest_espn_mlb.json (no new API calls).
 *
 * Since raw rows are team-level (not player-level), we proxy:
 *   - bullpenEra    = team runs-allowed per game average over 14 days (ERA proxy)
 *   - fatigueScore  = sum of games played by team over last 3 days
 *   - gamesLast3Days = count of completed games in last 3 days
 *
 * Output: data/processed/mlb-bullpen.json
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const RAW_PATH = path.join(root, "data/raw/mlb/latest_espn_mlb.json");
const OUT = path.join(root, "data/processed/mlb-bullpen.json");

// League-average bullpen ERA as fallback
const LEAGUE_AVG_ERA = 4.20;

type RawRow = {
  league: string;
  team: string;
  gameDate: string;
  points: number;
  opponentPoints: number | null;
  homeAway: string | null;
};

type TeamBullpen = {
  fatigueScore: number;
  bullpenEra: number;
  gamesLast3Days: number;
};

function parseDate(s: string): Date {
  return new Date(s);
}

function run() {
  if (!fs.existsSync(RAW_PATH)) {
    console.warn(`[mlb-bullpen] Raw file not found: ${RAW_PATH} — writing empty output`);
    fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), teams: {} }, null, 2));
    return;
  }

  const raw: RawRow[] = JSON.parse(fs.readFileSync(RAW_PATH, "utf-8"));
  const mlbRows = raw.filter((r) => r.league === "MLB");

  if (!mlbRows.length) {
    console.warn("[mlb-bullpen] No MLB rows in raw data");
    fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), teams: {} }, null, 2));
    return;
  }

  const now = Date.now();
  const MS_3_DAYS = 3 * 24 * 3600 * 1000;
  const MS_14_DAYS = 14 * 24 * 3600 * 1000;

  // Group by team
  const byTeam: Record<string, RawRow[]> = {};
  for (const row of mlbRows) {
    if (!byTeam[row.team]) byTeam[row.team] = [];
    byTeam[row.team].push(row);
  }

  const teams: Record<string, TeamBullpen> = {};

  for (const [team, rows] of Object.entries(byTeam)) {
    // Filter to completed past games
    const past = rows.filter((r) => {
      const ms = parseDate(r.gameDate).getTime();
      return ms < now && r.opponentPoints != null;
    });

    // Last 3 days → fatigue
    const last3 = past.filter((r) => now - parseDate(r.gameDate).getTime() <= MS_3_DAYS);
    const fatigueScore = parseFloat((last3.length * 2.5).toFixed(1)); // proxy: each game adds 2.5

    // Last 14 days → bullpen ERA proxy (runs allowed per game)
    const last14 = past.filter((r) => now - parseDate(r.gameDate).getTime() <= MS_14_DAYS);
    let bullpenEra: number;
    if (last14.length === 0) {
      bullpenEra = LEAGUE_AVG_ERA;
    } else {
      const runsAllowed = last14.reduce((s, r) => s + (r.opponentPoints ?? 0), 0);
      // Scale to per-9-innings estimate (MLB avg ~9 innings/game)
      bullpenEra = parseFloat(((runsAllowed / last14.length) * 1.0).toFixed(2));
    }

    teams[team] = {
      fatigueScore,
      bullpenEra,
      gamesLast3Days: last3.length,
    };
  }

  const out = { fetchedAt: new Date().toISOString(), teams };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[mlb-bullpen] Wrote bullpen data for ${Object.keys(teams).length} teams to ${OUT}`);
}

run();
