/**
 * ingest-wnba-efficiency.ts — Computes WNBA team net ratings from ESPN scoreboard history.
 *
 * Mirror of ingest-nba-efficiency.ts targeting the basketball/wnba ESPN endpoint.
 * Same per-100-possessions proxy via point differential per game, and the same
 * rules (src/lib/basketball-efficiency.ts): only regular-season and playoff
 * games count, a team needs MIN_GAMES_FOR_RATING of them to be rated, and a
 * file with no ratings is written whenever ESPN answers but nothing qualifies.
 *
 * Output: data/processed/wnba-efficiency.json
 * Usage:  npm run ingest:wnba-efficiency
 *
 * Note: WNBA season runs ~May–October. In offseason this script writes a file
 * with no teams and exits 0; it exits non-zero only on an ESPN outage.
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildTeamEfficiency,
  type EspnScoreboardEvent,
  type TeamEfficiencyRecord,
} from "../src/lib/basketball-efficiency";
import { MIN_GAMES_FOR_RATING } from "../src/lib/basketball-model";

try {
  const envFile = path.resolve(process.cwd(), ".env");
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch { /* no .env */ }

export type WnbaTeamEfficiency = TeamEfficiencyRecord;

export type WnbaEfficiencyData = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  minGamesForRating: number;
  gamesCounted: number;
  gamesExcluded: number;
  lastGameAt: string | null;
  belowMinimum: Record<string, number>;
  teams: Record<string, WnbaTeamEfficiency>;
};

type EspnScoreboard = { events?: EspnScoreboardEvent[] };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** null = the request failed; an answered day with no games is `{ events: [] }`. */
async function fetchScoreboard(dateStr: string): Promise<EspnScoreboard | null> {
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard` +
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

const isExhibition = (n: string) =>
  /\b(stars|world|rising|team\s+usa|select|all-star)\b/i.test(n);

async function main() {
  const root = process.cwd();
  // WNBA plays ~3 games/week per team vs NBA's ~3.5; widen lookback so the
  // sample size is comparable in early/mid-season.
  const LOOKBACK_DAYS = 60;

  console.log(
    `[wnba-efficiency] Computing WNBA team ratings from last ${LOOKBACK_DAYS} days of ESPN scores...`,
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
    await sleep(80);
  }

  if (fetchFailures > LOOKBACK_DAYS / 2) {
    console.error(
      `[wnba-efficiency] ${fetchFailures}/${LOOKBACK_DAYS} scoreboard fetches failed — ESPN outage? Leaving existing file.`,
    );
    process.exit(1);
  }

  const built = buildTeamEfficiency(events, { minGames: MIN_GAMES_FOR_RATING, isExhibition });
  const rated = Object.keys(built.teams).length;
  const below = Object.keys(built.belowMinimum).length;

  console.log(
    `[wnba-efficiency] Counted ${built.gamesCounted} games (skipped ${built.gamesExcluded} preseason/untyped). ` +
    `${rated} teams rated, ${below} below the ${MIN_GAMES_FOR_RATING}-game minimum` +
    (fetchFailures > 0 ? `, ${fetchFailures} days failed to fetch.` : "."),
  );
  if (rated === 0) {
    console.log("[wnba-efficiency] No team has enough games (likely offseason) — writing a file with no ratings.");
  }

  const sorted = Object.entries(built.teams)
    .filter(([, t]) => t.netRtg !== null)
    .sort(([, a], [, b]) => (b.netRtg as number) - (a.netRtg as number));

  if (sorted.length > 0) console.log("[wnba-efficiency] Top teams by net pts/game:");
  for (const [name, t] of sorted.slice(0, 10)) {
    console.log(
      `  ${String((t.netRtg as number).toFixed(1)).padStart(5)}  ${name}` +
      `  (Home: ${t.homeNetRtg?.toFixed(1) ?? "?"}  Away: ${t.awayNetRtg?.toFixed(1) ?? "?"}` +
      `  G: ${t.gamesPlayed})`,
    );
  }

  const output: WnbaEfficiencyData = {
    fetchedAt: new Date().toISOString(),
    season: built.seasonYear ? String(built.seasonYear) : "none",
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
  const outPath = path.join(outDir, "wnba-efficiency.json");

  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, outPath);
  } catch {
    try { fs.unlinkSync(outPath); } catch { /* ok */ }
    fs.renameSync(tmp, outPath);
  }

  console.log(`[wnba-efficiency] Written: ${outPath} (${rated} teams)`);
}

main().catch((err) => {
  console.error("[wnba-efficiency] Fatal:", err);
  process.exit(1);
});
