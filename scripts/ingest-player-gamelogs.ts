// Player game-log ingester. Walks the last N days of ESPN box scores for
// NBA + MLB, aggregates per-player stat lines with the team they played for
// and the opponent, then writes a flat JSON snapshot consumed by the prop
// projection engine (src/lib/prop-projector.ts).
//
// This is deterministic data — no LLM. The projector uses these snapshots
// to compute modelProb for a prop pick (rolling avg + opponent allowance
// adjustment + normal CDF). Without it, the analyst would have to invent
// modelProbs for props, which is exactly the failure mode we want to avoid.
//
// Run: npm run ingest:player-gamelogs
// Defaults to a 10-day window for NBA and 14-day for MLB. Pass `--days N`
// to override (uses the larger of NBA/MLB defaults).

import fs from "node:fs";
import path from "node:path";
import {
  fetchJson,
  normalizeName,
  yyyymmdd,
  SCOREBOARD,
  SUMMARY,
  PROP_STAT_MAP,
  type Espn,
  type EspnEvent,
  type EspnSummary,
  type PropGradingLeague,
} from "../src/lib/prop-grading";

type PerGameStats = { date: string; opponent: string | null; stats: Record<string, number> };

type PlayerEntry = {
  displayName: string;
  team: string | null;
  games: PerGameStats[];
};

type TeamAllowed = {
  games: number;
  allowed: Record<string, { mean: number; n: number }>;
};

type GameLogFile = {
  generatedAt: string;
  league: PropGradingLeague;
  windowDays: number;
  windowStart: string;       // ISO
  windowEnd: string;         // ISO
  players: Record<string, PlayerEntry>;          // key = normalized name
  teamsAllowed: Record<string, TeamAllowed>;     // key = team displayName
  leagueAverages: Record<string, number>;        // propType → mean across all player-games
};

const DEFAULT_DAYS: Record<PropGradingLeague, number> = {
  NBA: 10,
  MLB: 14,
  // WNBA plays ~3–4 games/week/team, so a 10-day window gives ~4–5 games per
  // player — right at the projector's MIN_GAMES=5 floor. Widen slightly to 14
  // so most rotation players clear the threshold.
  WNBA: 14,
};

const OUT_DIR = path.resolve(process.cwd(), "data", "processed");

function parseArgs(): { days?: number } {
  const idx = process.argv.indexOf("--days");
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (Number.isFinite(n) && n > 0) return { days: n };
  }
  return {};
}

async function buildGameLog(
  league: PropGradingLeague,
  windowDays: number
): Promise<GameLogFile> {
  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(yyyymmdd(d));
  }

  const seenEvents = new Set<string>();
  const events: Array<EspnEvent & { homeName: string; awayName: string }> = [];
  for (const d of dates) {
    const board = await fetchJson<Espn>(`${SCOREBOARD[league]}?dates=${d}`);
    for (const ev of board?.events ?? []) {
      if (seenEvents.has(ev.id)) continue;
      if (!ev.status?.type?.completed) continue;
      const competitors = ev.competitions?.[0]?.competitors ?? [];
      const home = competitors.find(c => c.homeAway === "home")?.team?.displayName ?? "";
      const away = competitors.find(c => c.homeAway === "away")?.team?.displayName ?? "";
      if (!home || !away) continue;
      seenEvents.add(ev.id);
      events.push({ ...ev, homeName: home, awayName: away });
    }
  }

  const players: Record<string, PlayerEntry> = {};
  const teamsAllowed: Record<string, TeamAllowed> = {};
  const leagueTotals: Record<string, { sum: number; n: number }> = {};

  for (const ev of events) {
    const summary = await fetchJson<EspnSummary>(`${SUMMARY[league]}?event=${ev.id}`);
    if (!summary?.boxscore?.players) continue;

    for (const teamBlock of summary.boxscore.players) {
      const teamName = teamBlock.team?.displayName ?? "";
      if (!teamName) continue;
      const opponent = teamName === ev.homeName ? ev.awayName
        : teamName === ev.awayName ? ev.homeName
        : null;

      // Make sure the team's allowed counter has a slot even on games with
      // no extracted player rows (e.g., summary parse mishap).
      teamsAllowed[teamName] ??= { games: 0, allowed: {} };

      for (const stat of teamBlock.statistics ?? []) {
        const labels = stat.labels ?? [];
        for (const ath of stat.athletes ?? []) {
          const name = ath.athlete?.displayName;
          const rawStats = ath.stats ?? [];
          if (!name || rawStats.length === 0) continue;
          const norm = normalizeName(name);
          const statMap: Record<string, number> = {};
          for (let i = 0; i < Math.min(labels.length, rawStats.length); i++) {
            const num = parseFloat(rawStats[i]);
            if (Number.isFinite(num)) statMap[labels[i]] = num;
          }
          if (Object.keys(statMap).length === 0) continue;

          // Compute every prop-type value we know how to extract from this
          // stat map. Storing the prop-type-keyed values directly saves the
          // projector from having to re-run PROP_STAT_MAP on every query.
          const propValues: Record<string, number> = {};
          for (const [propType, compute] of Object.entries(PROP_STAT_MAP)) {
            const v = compute(new Map(Object.entries(statMap)));
            if (v !== null) {
              propValues[propType] = v;
              leagueTotals[propType] ??= { sum: 0, n: 0 };
              leagueTotals[propType].sum += v;
              leagueTotals[propType].n++;
              // Opponent allowance: for each propType the OPPONENT'S team
              // had this value scored against it. Track running mean.
              if (opponent) {
                teamsAllowed[opponent] ??= { games: 0, allowed: {} };
                const slot = (teamsAllowed[opponent].allowed[propType] ??= { mean: 0, n: 0 });
                slot.mean = (slot.mean * slot.n + v) / (slot.n + 1);
                slot.n++;
              }
            }
          }

          const player = (players[norm] ??= {
            displayName: name,
            team: teamName,
            games: [],
          });
          // The last observed team wins — handles mid-window trades by
          // attributing the player to their most recent franchise.
          player.team = teamName;
          player.games.push({
            date: ev.date ?? "",
            opponent,
            stats: propValues,
          });
        }
      }

      teamsAllowed[teamName].games++;
    }
  }

  const leagueAverages: Record<string, number> = {};
  for (const [propType, { sum, n }] of Object.entries(leagueTotals)) {
    if (n > 0) leagueAverages[propType] = +(sum / n).toFixed(3);
  }

  return {
    generatedAt: new Date().toISOString(),
    league,
    windowDays,
    windowStart: dates[dates.length - 1],
    windowEnd: dates[0],
    players,
    teamsAllowed,
    leagueAverages,
  };
}

async function main() {
  const { days } = parseArgs();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let failures = 0;
  let successes = 0;
  for (const league of ["NBA", "MLB", "WNBA"] as const) {
    const windowDays = days ?? DEFAULT_DAYS[league];
    console.log(`\n[${league}] building game log (${windowDays} day window)...`);
    const log = await buildGameLog(league, windowDays);
    const filename = `player-gamelogs-${league.toLowerCase()}.json`;
    const out = path.join(OUT_DIR, filename);
    const playerCount = Object.keys(log.players).length;
    const teamCount = Object.keys(log.teamsAllowed).length;

    // SELF-CORRUPTION GUARD: a build that scraped ZERO players almost certainly
    // means every ESPN fetch failed (rate-limit / outage), NOT that no games
    // happened in a 10–14 day window. Writing it would overwrite a good file
    // with an empty one AND reset its generatedAt — defeating the downstream
    // freshness gate (it would look "fresh but empty" instead of "stale"). So we
    // refuse the write, leave the last-known-good file in place, and flag a
    // failure so the cron exits non-zero and the heartbeat fires.
    if (playerCount === 0) {
      console.error(
        `[${league}] REFUSING to write — 0 players parsed (ESPN outage / rate-limit?). ` +
          `Leaving existing ${filename} untouched so stale data stays visibly stale.`,
      );
      failures++;
      continue;
    }

    // Atomic write (temp + rename) so a reader never catches a half-written file.
    const tmp = `${out}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
    fs.renameSync(tmp, out);
    successes++;
    console.log(
      `[${league}] wrote ${out} — ${playerCount} players, ${teamCount} teams, ${Object.keys(log.leagueAverages).length} prop types`
    );
  }
  // Exit non-zero ONLY on a TOTAL wipeout (every league empty) — that's a real
  // ESPN outage worth surfacing to the scheduler/heartbeat. A single league
  // returning zero is almost always an offseason (e.g. NBA in June), which is
  // expected, not a failure — so we don't paint the run red for it.
  if (failures > 0 && successes === 0) {
    console.error("[gamelogs] ALL leagues empty — likely ESPN outage. Exiting non-zero.");
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
