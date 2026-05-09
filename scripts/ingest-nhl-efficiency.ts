/**
 * ingest-nhl-efficiency.ts — Computes NHL team net ratings from ESPN scoreboard history.
 *
 * Mirror of ingest-nba-efficiency.ts targeting hockey/nhl. Per-100-possessions
 * proxy doesn't translate cleanly to hockey, so this uses raw goal differential
 * per game (overall + home/away splits). hockey-model.ts converts that to an
 * expected single-game margin and a win probability via the same logistic shape
 * the basketball model uses.
 *
 * Output: data/processed/nhl-efficiency.json
 * Usage:  npm run ingest:nhl-efficiency
 *
 * Note: NHL regular season is Oct–Apr; Stanley Cup playoffs Apr–Jun. In late
 * June through September there are no completed games, in which case this
 * script writes an empty file and exits 0 so callers can stay non-fatal.
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

export type NhlTeamRating = {
  netRtg: number | null; // goal differential per game (overall)
  goalsFor: number | null;
  goalsAgainst: number | null;
  homeNetRtg: number | null;
  homeGoalsFor: number | null;
  homeGoalsAgainst: number | null;
  awayNetRtg: number | null;
  awayGoalsFor: number | null;
  awayGoalsAgainst: number | null;
  gamesPlayed: number;
};

export type NhlEfficiencyData = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  teams: Record<string, NhlTeamRating>;
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
    `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard` +
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
  // 60 days covers ~24-30 games per team late in the regular season and gives
  // playoff teams a meaningful tail when used in May/June. Adjust higher if
  // running off-season recovery.
  const LOOKBACK_DAYS = 60;

  console.log(
    `[nhl-efficiency] Computing NHL team ratings from last ${LOOKBACK_DAYS} days of ESPN scores...`,
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
        /\b(stars|world|all-star)\b/i.test(n);
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
    `[nhl-efficiency] Scraped ${totalGames} games across ${daysWithGames} days. ` +
    `${accum.size} teams.`,
  );

  if (accum.size === 0) {
    const outDir = path.join(root, "data", "processed");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "nhl-efficiency.json");
    const empty: NhlEfficiencyData = {
      fetchedAt: new Date().toISOString(),
      season: "2025-26",
      source: "espn-scoreboard-empirical",
      lookbackDays: LOOKBACK_DAYS,
      teams: {},
    };
    fs.writeFileSync(outPath, JSON.stringify(empty, null, 2), "utf-8");
    console.log("[nhl-efficiency] No completed games in lookback window (likely offseason). Wrote empty file.");
    return;
  }

  const teams: Record<string, NhlTeamRating> = {};
  for (const [teamName, a] of accum) {
    const netRtg = a.games > 0 ? (a.scored - a.allowed) / a.games : null;
    const goalsFor = a.games > 0 ? a.scored / a.games : null;
    const goalsAgainst = a.games > 0 ? a.allowed / a.games : null;
    const homeNetRtg = a.homeGames > 0 ? (a.homeScored - a.homeAllowed) / a.homeGames : null;
    const awayNetRtg = a.awayGames > 0 ? (a.awayScored - a.awayAllowed) / a.awayGames : null;

    teams[teamName] = {
      netRtg,
      goalsFor,
      goalsAgainst,
      homeNetRtg,
      homeGoalsFor: a.homeGames > 0 ? a.homeScored / a.homeGames : null,
      homeGoalsAgainst: a.homeGames > 0 ? a.homeAllowed / a.homeGames : null,
      awayNetRtg,
      awayGoalsFor: a.awayGames > 0 ? a.awayScored / a.awayGames : null,
      awayGoalsAgainst: a.awayGames > 0 ? a.awayAllowed / a.awayGames : null,
      gamesPlayed: a.games,
    };
  }

  const sorted = Object.entries(teams)
    .filter(([, t]) => t.netRtg !== null)
    .sort(([, a], [, b]) => (b.netRtg as number) - (a.netRtg as number));

  console.log("[nhl-efficiency] Top teams by net goals/game:");
  for (const [name, t] of sorted.slice(0, 10)) {
    console.log(
      `  ${String((t.netRtg as number).toFixed(2)).padStart(6)}  ${name}` +
      `  (Home: ${t.homeNetRtg?.toFixed(2) ?? "?"}  Away: ${t.awayNetRtg?.toFixed(2) ?? "?"}` +
      `  G: ${t.gamesPlayed})`,
    );
  }

  const output: NhlEfficiencyData = {
    fetchedAt: new Date().toISOString(),
    season: "2025-26",
    source: "espn-scoreboard-empirical",
    lookbackDays: LOOKBACK_DAYS,
    teams,
  };

  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "nhl-efficiency.json");

  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, outPath);
  } catch {
    try { fs.unlinkSync(outPath); } catch { /* ok */ }
    fs.renameSync(tmp, outPath);
  }

  console.log(`[nhl-efficiency] Written: ${outPath} (${Object.keys(teams).length} teams)`);
}

main().catch((err) => {
  console.error("[nhl-efficiency] Fatal:", err);
  process.exit(1);
});
