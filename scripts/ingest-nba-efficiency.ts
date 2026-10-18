/**
 * ingest-nba-efficiency.ts — Computes NBA team net ratings from ESPN scoreboard history
 *
 * NBA.com's leaguedashteamstats endpoint returns HTTP 500 (server-side .NET bug).
 * This script instead fetches the last 40 days of completed NBA scores from ESPN,
 * then computes per-team point differential as a net-rating proxy.
 *
 * With NBA pace ~100 possessions/game, raw pt-diff/game ≈ per-100-possessions net rating.
 * Home/away splits are computed separately for the efficiency spread formula.
 *
 * Only regular-season, play-in and playoff games count, and a team is rated
 * only after MIN_GAMES_FOR_RATING of them (src/lib/basketball-efficiency.ts).
 * When ESPN answers but nothing qualifies — preseason, offseason, opening
 * week — the file is still written, with no teams, so nothing downstream can
 * keep reading an older file. Only an ESPN outage leaves the old file in place
 * (and basketball-model.ts refuses a file past its age limit).
 *
 * Output: data/processed/nba-efficiency.json
 * Usage: npm run ingest:nba-efficiency
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildTeamEfficiency,
  type EspnScoreboardEvent,
  type TeamEfficiencyRecord,
} from "../src/lib/basketball-efficiency";
import { MIN_GAMES_FOR_RATING } from "../src/lib/basketball-model";
import { nbaSeasonLabel } from "../src/lib/espn-season";

// Load .env (best-effort)
try {
  const envFile = path.resolve(process.cwd(), ".env");
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch { /* no .env */ }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NbaTeamEfficiency = TeamEfficiencyRecord;

export type NbaEfficiencyData = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  minGamesForRating: number;
  gamesCounted: number;
  gamesExcluded: number;
  lastGameAt: string | null;
  belowMinimum: Record<string, number>;
  teams: Record<string, NbaTeamEfficiency>;
};

type EspnScoreboard = { events?: EspnScoreboardEvent[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** null = the request failed; an answered day with no games is `{ events: [] }`. */
async function fetchScoreboard(dateStr: string): Promise<EspnScoreboard | null> {
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard` +
    `?dates=${dateStr}&limit=20`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as EspnScoreboard;
  } catch {
    return null;
  }
}

// Skip All-Star/exhibition games (team names include "Stars", "World", "Rising Stars")
const isExhibition = (n: string) =>
  /\b(stars|world|rising|team\s+usa|select)\b/i.test(n);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = process.cwd();
  const LOOKBACK_DAYS = 40;

  console.log(
    `[nba-efficiency] Computing NBA team ratings from last ${LOOKBACK_DAYS} days of ESPN scores...`,
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const events: EspnScoreboardEvent[] = [];
  let fetchFailures = 0;
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const board = await fetchScoreboard(toDateStr(d));
    if (board === null) fetchFailures++;
    else events.push(...(board.events ?? []));
    await sleep(80); // polite to ESPN
  }

  // Most days unanswered = ESPN outage, not a quiet calendar. Keep the last
  // good file rather than replace it with an empty one.
  if (fetchFailures > LOOKBACK_DAYS / 2) {
    console.error(
      `[nba-efficiency] ${fetchFailures}/${LOOKBACK_DAYS} scoreboard fetches failed — ESPN outage? Leaving existing file.`,
    );
    process.exit(1);
  }

  const built = buildTeamEfficiency(events, { minGames: MIN_GAMES_FOR_RATING, isExhibition });
  const rated = Object.keys(built.teams).length;
  const below = Object.keys(built.belowMinimum).length;

  console.log(
    `[nba-efficiency] Counted ${built.gamesCounted} games (skipped ${built.gamesExcluded} preseason/untyped). ` +
    `${rated} teams rated, ${below} below the ${MIN_GAMES_FOR_RATING}-game minimum` +
    (fetchFailures > 0 ? `, ${fetchFailures} days failed to fetch.` : "."),
  );
  if (rated === 0) {
    console.log("[nba-efficiency] No team has enough games — writing a file with no ratings (the model will skip NBA games).");
  }

  // Print top 10 for verification
  const sorted = Object.entries(built.teams)
    .filter(([, t]) => t.netRtg !== null)
    .sort(([, a], [, b]) => (b.netRtg as number) - (a.netRtg as number));

  if (sorted.length > 0) console.log("[nba-efficiency] Top 10 by net pts/game:");
  for (const [name, t] of sorted.slice(0, 10)) {
    console.log(
      `  ${String((t.netRtg as number).toFixed(1)).padStart(5)}  ${name}` +
      `  (Home: ${t.homeNetRtg?.toFixed(1) ?? "?"}  Away: ${t.awayNetRtg?.toFixed(1) ?? "?"}` +
      `  G: ${t.gamesPlayed})`,
    );
  }

  const output: NbaEfficiencyData = {
    fetchedAt: new Date().toISOString(),
    season: built.seasonYear ? nbaSeasonLabel(built.seasonYear) : "none",
    source: "espn-scoreboard-empirical",
    lookbackDays: LOOKBACK_DAYS,
    minGamesForRating: MIN_GAMES_FOR_RATING,
    gamesCounted: built.gamesCounted,
    gamesExcluded: built.gamesExcluded,
    lastGameAt: built.lastGameAt,
    belowMinimum: built.belowMinimum,
    teams: built.teams,
  };

  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "nba-efficiency.json");

  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, outPath);
  } catch {
    try { fs.unlinkSync(outPath); } catch { /* ok */ }
    fs.renameSync(tmp, outPath);
  }

  console.log(`[nba-efficiency] Written: ${outPath} (${rated} teams)`);
}

main().catch((err) => {
  console.error("[nba-efficiency] Fatal:", err);
  process.exit(1);
});
