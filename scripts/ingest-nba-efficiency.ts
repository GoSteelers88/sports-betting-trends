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
 * Output: data/processed/nba-efficiency.json
 * Usage: npm run ingest:nba-efficiency
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

export type NbaTeamEfficiency = {
  netRtg: number | null;
  offRtg: number | null;
  defRtg: number | null;
  pace: number | null;
  homeNetRtg: number | null;
  homeOffRtg: number | null;
  homeDefRtg: number | null;
  awayNetRtg: number | null;
  awayOffRtg: number | null;
  awayDefRtg: number | null;
  gamesPlayed: number;
};

export type NbaEfficiencyData = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  teams: Record<string, NbaTeamEfficiency>;
};

type TeamAccum = {
  scored: number; allowed: number; games: number;
  homeScored: number; homeAllowed: number; homeGames: number;
  awayScored: number; awayAllowed: number; awayGames: number;
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
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = process.cwd();
  const LOOKBACK_DAYS = 40;

  console.log(
    `[nba-efficiency] Computing NBA team ratings from last ${LOOKBACK_DAYS} days of ESPN scores...`,
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

    const board = await fetchScoreboard(ds);
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

      // Skip All-Star/exhibition games (team names include "Stars", "World", "Rising Stars")
      const isExhibition = (n: string) =>
        /\b(stars|world|rising|team\s+usa|select)\b/i.test(n);
      if (isExhibition(homeTeam) || isExhibition(awayTeam)) continue;

      dayGames++;

      const empty = (): TeamAccum => ({
        scored: 0, allowed: 0, games: 0,
        homeScored: 0, homeAllowed: 0, homeGames: 0,
        awayScored: 0, awayAllowed: 0, awayGames: 0,
      });

      // Home team
      const ha = accum.get(homeTeam) ?? empty();
      ha.scored += homeScore; ha.allowed += awayScore; ha.games++;
      ha.homeScored += homeScore; ha.homeAllowed += awayScore; ha.homeGames++;
      accum.set(homeTeam, ha);

      // Away team
      const aa = accum.get(awayTeam) ?? empty();
      aa.scored += awayScore; aa.allowed += homeScore; aa.games++;
      aa.awayScored += awayScore; aa.awayAllowed += homeScore; aa.awayGames++;
      accum.set(awayTeam, aa);
    }

    if (dayGames > 0) {
      daysWithGames++;
      totalGames += dayGames;
    }

    await sleep(80); // polite to ESPN
  }

  console.log(
    `[nba-efficiency] Scraped ${totalGames} games across ${daysWithGames} days. ` +
    `${accum.size} teams.`,
  );

  if (accum.size === 0) {
    console.error("[nba-efficiency] No game data found — aborting");
    process.exit(1);
  }

  // Build efficiency records
  const teams: Record<string, NbaTeamEfficiency> = {};
  for (const [teamName, a] of accum) {
    const netRtg = a.games > 0 ? (a.scored - a.allowed) / a.games : null;
    const offRtg = a.games > 0 ? a.scored / a.games : null;
    const defRtg = a.games > 0 ? a.allowed / a.games : null;
    const homeNetRtg = a.homeGames > 0 ? (a.homeScored - a.homeAllowed) / a.homeGames : null;
    const awayNetRtg = a.awayGames > 0 ? (a.awayScored - a.awayAllowed) / a.awayGames : null;

    teams[teamName] = {
      netRtg,
      offRtg,
      defRtg,
      pace: null, // not derivable from score-only data
      homeNetRtg,
      homeOffRtg: a.homeGames > 0 ? a.homeScored / a.homeGames : null,
      homeDefRtg: a.homeGames > 0 ? a.homeAllowed / a.homeGames : null,
      awayNetRtg,
      awayOffRtg: a.awayGames > 0 ? a.awayScored / a.awayGames : null,
      awayDefRtg: a.awayGames > 0 ? a.awayAllowed / a.awayGames : null,
      gamesPlayed: a.games,
    };
  }

  // Print top 10 for verification
  const sorted = Object.entries(teams)
    .filter(([, t]) => t.netRtg !== null)
    .sort(([, a], [, b]) => (b.netRtg as number) - (a.netRtg as number));

  console.log("[nba-efficiency] Top 10 by net pts/game:");
  for (const [name, t] of sorted.slice(0, 10)) {
    console.log(
      `  ${String((t.netRtg as number).toFixed(1)).padStart(5)}  ${name}` +
      `  (Home: ${t.homeNetRtg?.toFixed(1) ?? "?"}  Away: ${t.awayNetRtg?.toFixed(1) ?? "?"}` +
      `  G: ${t.gamesPlayed})`,
    );
  }

  const output: NbaEfficiencyData = {
    fetchedAt: new Date().toISOString(),
    season: "2025-26",
    source: "espn-scoreboard-empirical",
    lookbackDays: LOOKBACK_DAYS,
    teams,
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

  console.log(`[nba-efficiency] Written: ${outPath} (${Object.keys(teams).length} teams)`);
}

main().catch((err) => {
  console.error("[nba-efficiency] Fatal:", err);
  process.exit(1);
});
