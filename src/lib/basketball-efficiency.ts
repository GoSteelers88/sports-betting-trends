// basketball-efficiency.ts — team ratings from ESPN scoreboard results.
//
// Shared by ingest-nba-efficiency and ingest-wnba-efficiency, which used to
// carry two copies of this loop (and two copies of the same bug: preseason
// games counted, and nothing stopped a team with one game from being rated).
//
// Rating = point differential per game, split home/away. With pace ~100
// possessions, pts/game ≈ a per-100 net rating. Only games ESPN marks as
// regular season, play-in or postseason count (see espn-season.ts), and a
// team is rated only once it has `minGames` of them; teams below that are
// listed in `belowMinimum` so readers can say why a game went unmodeled.

import { isCountableEspnEvent } from "./espn-season";

export type EspnScoreboardEvent = {
  id?: string;
  date?: string;
  season?: { type?: number; year?: number };
  competitions?: Array<{
    status?: { type?: { completed?: boolean } };
    competitors?: Array<{
      homeAway?: "home" | "away";
      score?: string;
      team?: { displayName?: string };
    }>;
  }>;
};

export type TeamEfficiencyRecord = {
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

export type EfficiencyBuild = {
  /** Teams with at least `minGames` countable games. */
  teams: Record<string, TeamEfficiencyRecord>;
  /** Teams with countable games, but fewer than `minGames`: team → games. */
  belowMinimum: Record<string, number>;
  gamesCounted: number;
  /** Completed games skipped because ESPN marks them preseason (or untyped). */
  gamesExcluded: number;
  /** Start time of the newest counted game, or null when none counted. */
  lastGameAt: string | null;
  /** ESPN season.year of the newest counted game. */
  seasonYear: number | null;
};

type TeamAccum = {
  scored: number; allowed: number; games: number;
  homeScored: number; homeAllowed: number; homeGames: number;
  awayScored: number; awayAllowed: number; awayGames: number;
};

const emptyAccum = (): TeamAccum => ({
  scored: 0, allowed: 0, games: 0,
  homeScored: 0, homeAllowed: 0, homeGames: 0,
  awayScored: 0, awayAllowed: 0, awayGames: 0,
});

export function buildTeamEfficiency(
  events: EspnScoreboardEvent[],
  opts: { minGames: number; isExhibition: (teamName: string) => boolean },
): EfficiencyBuild {
  const accum = new Map<string, TeamAccum>();
  const seen = new Set<string>();
  let gamesCounted = 0;
  let gamesExcluded = 0;
  let lastGameAt: string | null = null;
  let seasonYear: number | null = null;

  for (const event of events) {
    if (event.id) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
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

    // All-Star games are season type 2, so the name check stays.
    if (opts.isExhibition(homeTeam) || opts.isExhibition(awayTeam)) continue;
    if (!isCountableEspnEvent(event)) {
      gamesExcluded++;
      continue;
    }

    gamesCounted++;
    if (event.date && (lastGameAt === null || event.date > lastGameAt)) {
      lastGameAt = event.date;
      seasonYear = event.season?.year ?? seasonYear;
    }

    const ha = accum.get(homeTeam) ?? emptyAccum();
    ha.scored += homeScore; ha.allowed += awayScore; ha.games++;
    ha.homeScored += homeScore; ha.homeAllowed += awayScore; ha.homeGames++;
    accum.set(homeTeam, ha);

    const aa = accum.get(awayTeam) ?? emptyAccum();
    aa.scored += awayScore; aa.allowed += homeScore; aa.games++;
    aa.awayScored += awayScore; aa.awayAllowed += homeScore; aa.awayGames++;
    accum.set(awayTeam, aa);
  }

  const teams: Record<string, TeamEfficiencyRecord> = {};
  const belowMinimum: Record<string, number> = {};
  for (const [teamName, a] of accum) {
    if (a.games < opts.minGames) {
      belowMinimum[teamName] = a.games;
      continue;
    }
    teams[teamName] = {
      netRtg: (a.scored - a.allowed) / a.games,
      offRtg: a.scored / a.games,
      defRtg: a.allowed / a.games,
      pace: null, // not derivable from score-only data
      homeNetRtg: a.homeGames > 0 ? (a.homeScored - a.homeAllowed) / a.homeGames : null,
      homeOffRtg: a.homeGames > 0 ? a.homeScored / a.homeGames : null,
      homeDefRtg: a.homeGames > 0 ? a.homeAllowed / a.homeGames : null,
      awayNetRtg: a.awayGames > 0 ? (a.awayScored - a.awayAllowed) / a.awayGames : null,
      awayOffRtg: a.awayGames > 0 ? a.awayScored / a.awayGames : null,
      awayDefRtg: a.awayGames > 0 ? a.awayAllowed / a.awayGames : null,
      gamesPlayed: a.games,
    };
  }

  return { teams, belowMinimum, gamesCounted, gamesExcluded, lastGameAt, seasonYear };
}
