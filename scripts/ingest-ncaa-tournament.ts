/**
 * ingest-ncaa-tournament.ts — Builds NCAAB team strength ratings for March Madness futures
 *
 * Problem: teamAdvanced.netRating in latest-summary.json is always null (requires
 * shot-level box score data that ESPN's scoreboard API doesn't provide).
 *
 * Solution: Compute point-differential-per-game directly from ESPN NCAAB scoreboard,
 * same approach as ingest-nba-efficiency.ts.
 *
 * Output: data/processed/ncaa-tournament-ratings.json
 *   { fetchedAt, sourceFile, teams: { "Duke Blue Devils": 12.3, ... } }
 *
 * Used by ingest-kalshi.ts findTournamentEdge() for KXMARMAD-26-* futures.
 *
 * Usage: npm run ingest:ncaa-tournament
 */

import fs from "node:fs";
import path from "node:path";

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

export type TournamentRatings = {
  fetchedAt: string;
  sourceFile: string;
  teams: Record<string, number | null>;
};

type TeamAccum = {
  scored: number;
  allowed: number;
  games: number;
};

type EspnScoreboard = {
  events?: Array<{
    competitions?: Array<{
      status?: { type?: { completed?: boolean } };
      competitors?: Array<{
        homeAway?: "home" | "away";
        score?: string;
        team?: { displayName?: string };
      }>;
    }>;
  }>;
};

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

function writeAtomic(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
    fs.renameSync(tmp, filePath);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchNcaabScoreboard(dateStr: string): Promise<EspnScoreboard | null> {
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard` +
    `?dates=${dateStr}&limit=100&groups=50`; // groups=50 = top D1 teams
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as EspnScoreboard;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = process.cwd();
  const processedDir = path.join(root, "data", "processed");
  const LOOKBACK_DAYS = 25; // last 25 days of NCAAB games

  console.log(
    `[ncaa-tournament] Computing NCAAB team ratings from last ${LOOKBACK_DAYS} days of ESPN scores...`,
  );

  const accum = new Map<string, TeamAccum>();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let daysWithGames = 0;
  let totalGames = 0;

  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = toDateStr(d);

    const board = await fetchNcaabScoreboard(ds);
    if (!board?.events?.length) {
      await sleep(80);
      continue;
    }

    let dayGames = 0;
    for (const event of board.events) {
      const comp = event.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;

      const competitors = comp.competitors ?? [];
      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");
      if (!home || !away) continue;

      const homeTeam = home.team?.displayName?.trim();
      const awayTeam = away.team?.displayName?.trim();
      const homeScore = parseFloat(home.score ?? "");
      const awayScore = parseFloat(away.score ?? "");

      if (!homeTeam || !awayTeam || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

      dayGames++;

      const empty = (): TeamAccum => ({ scored: 0, allowed: 0, games: 0 });

      const ha = accum.get(homeTeam) ?? empty();
      ha.scored += homeScore; ha.allowed += awayScore; ha.games++;
      accum.set(homeTeam, ha);

      const aa = accum.get(awayTeam) ?? empty();
      aa.scored += awayScore; aa.allowed += homeScore; aa.games++;
      accum.set(awayTeam, aa);
    }

    if (dayGames > 0) { daysWithGames++; totalGames += dayGames; }
    await sleep(80);
  }

  console.log(
    `[ncaa-tournament] Scraped ${totalGames} games across ${daysWithGames} days. ` +
    `${accum.size} teams.`,
  );

  // Build ratings: net pts/game as SRS proxy
  const teams: Record<string, number | null> = {};
  for (const [teamName, a] of accum) {
    teams[teamName] = a.games >= 3
      ? Math.round(((a.scored - a.allowed) / a.games) * 100) / 100
      : null; // too few games → unreliable
  }

  const validCount = Object.values(teams).filter((v) => v !== null).length;
  console.log(`[ncaa-tournament] ${Object.keys(teams).length} teams found, ${validCount} with valid rating.`);

  // Print top 10 by SRS
  const sorted = Object.entries(teams)
    .filter(([, v]) => v !== null)
    .sort(([, a], [, b]) => (b as number) - (a as number));

  console.log("[ncaa-tournament] Top 10 by net pts/game:");
  for (const [team, srs] of sorted.slice(0, 10)) {
    console.log(`  ${String((srs as number).toFixed(2)).padStart(7)}  ${team}`);
  }

  const output: TournamentRatings = {
    fetchedAt: new Date().toISOString(),
    sourceFile: "espn-college-basketball-scoreboard",
    teams,
  };

  fs.mkdirSync(processedDir, { recursive: true });
  const outPath = path.join(processedDir, "ncaa-tournament-ratings.json");
  writeAtomic(outPath, output);

  console.log(`[ncaa-tournament] Written: ${outPath}`);
}

main().catch((err) => {
  console.error("[ncaa-tournament] Fatal:", err);
  process.exit(1);
});
