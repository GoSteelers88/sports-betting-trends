/**
 * ingest-wnba-efficiency.ts — Computes WNBA team net ratings from ESPN scoreboard history.
 *
 * Mirror of ingest-nba-efficiency.ts targeting the basketball/wnba ESPN endpoint.
 * Same per-100-possessions proxy via point differential per game.
 *
 * Output: data/processed/wnba-efficiency.json
 * Usage:  npm run ingest:wnba-efficiency
 *
 * Note: WNBA season runs ~May–October. In offseason this script will return zero
 * games and exit non-zero — callers should treat that as non-fatal.
 */

import fs from "node:fs";
import path from "node:path";

try {
  const envFile = path.resolve(process.cwd(), ".env");
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch { /* no .env */ }

export type WnbaTeamEfficiency = {
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

export type WnbaEfficiencyData = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  teams: Record<string, WnbaTeamEfficiency>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

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

async function main() {
  const root = process.cwd();
  // WNBA plays ~3 games/week per team vs NBA's ~3.5; widen lookback so the
  // sample size is comparable in early/mid-season.
  const LOOKBACK_DAYS = 60;

  console.log(
    `[wnba-efficiency] Computing WNBA team ratings from last ${LOOKBACK_DAYS} days of ESPN scores...`,
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

      const isExhibition = (n: string) =>
        /\b(stars|world|rising|team\s+usa|select|all-star)\b/i.test(n);
      if (isExhibition(homeTeam) || isExhibition(awayTeam)) continue;

      dayGames++;

      const empty = (): TeamAccum => ({
        scored: 0, allowed: 0, games: 0,
        homeScored: 0, homeAllowed: 0, homeGames: 0,
        awayScored: 0, awayAllowed: 0, awayGames: 0,
      });

      const ha = accum.get(homeTeam) ?? empty();
      ha.scored += homeScore; ha.allowed += awayScore; ha.games++;
      ha.homeScored += homeScore; ha.homeAllowed += awayScore; ha.homeGames++;
      accum.set(homeTeam, ha);

      const aa = accum.get(awayTeam) ?? empty();
      aa.scored += awayScore; aa.allowed += homeScore; aa.games++;
      aa.awayScored += awayScore; aa.awayAllowed += homeScore; aa.awayGames++;
      accum.set(awayTeam, aa);
    }

    if (dayGames > 0) {
      daysWithGames++;
      totalGames += dayGames;
    }

    await sleep(80);
  }

  console.log(
    `[wnba-efficiency] Scraped ${totalGames} games across ${daysWithGames} days. ` +
    `${accum.size} teams.`,
  );

  if (accum.size === 0) {
    // Likely offseason. Write an empty file so downstream readers don't crash,
    // but exit 0 so the workflow doesn't fail when WNBA simply isn't playing.
    const outDir = path.join(root, "data", "processed");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "wnba-efficiency.json");
    const empty: WnbaEfficiencyData = {
      fetchedAt: new Date().toISOString(),
      season: "2026",
      source: "espn-scoreboard-empirical",
      lookbackDays: LOOKBACK_DAYS,
      teams: {},
    };
    fs.writeFileSync(outPath, JSON.stringify(empty, null, 2), "utf-8");
    console.log("[wnba-efficiency] No completed games in lookback window (likely offseason). Wrote empty file.");
    return;
  }

  const teams: Record<string, WnbaTeamEfficiency> = {};
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
      pace: null,
      homeNetRtg,
      homeOffRtg: a.homeGames > 0 ? a.homeScored / a.homeGames : null,
      homeDefRtg: a.homeGames > 0 ? a.homeAllowed / a.homeGames : null,
      awayNetRtg,
      awayOffRtg: a.awayGames > 0 ? a.awayScored / a.awayGames : null,
      awayDefRtg: a.awayGames > 0 ? a.awayAllowed / a.awayGames : null,
      gamesPlayed: a.games,
    };
  }

  const sorted = Object.entries(teams)
    .filter(([, t]) => t.netRtg !== null)
    .sort(([, a], [, b]) => (b.netRtg as number) - (a.netRtg as number));

  console.log("[wnba-efficiency] Top teams by net pts/game:");
  for (const [name, t] of sorted.slice(0, 10)) {
    console.log(
      `  ${String((t.netRtg as number).toFixed(1)).padStart(5)}  ${name}` +
      `  (Home: ${t.homeNetRtg?.toFixed(1) ?? "?"}  Away: ${t.awayNetRtg?.toFixed(1) ?? "?"}` +
      `  G: ${t.gamesPlayed})`,
    );
  }

  const output: WnbaEfficiencyData = {
    fetchedAt: new Date().toISOString(),
    season: "2026",
    source: "espn-scoreboard-empirical",
    lookbackDays: LOOKBACK_DAYS,
    teams,
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

  console.log(`[wnba-efficiency] Written: ${outPath} (${Object.keys(teams).length} teams)`);
}

main().catch((err) => {
  console.error("[wnba-efficiency] Fatal:", err);
  process.exit(1);
});
