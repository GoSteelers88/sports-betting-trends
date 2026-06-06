// DB-free ESPN finals settlement — fetches completed game scores from ESPN's
// public scoreboard and grades a moneyline pick against them. Mirrors the
// proven matching logic in src/lib/agent/autograder.ts but WITHOUT the prisma
// coupling, so the de-vig paper book (JSON-backed, no DB) can settle bets on
// real game outcomes.
//
// Reuses the same token-aware team matcher as the fair-value engine so a pick
// and an ESPN final are joined identically everywhere in the app.

import { teamMatches } from "./fair-value";

export type FinalsLeague = "NBA" | "MLB";

const ESPN_SCOREBOARD: Record<FinalsLeague, string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
};

export type GameFinal = {
  league: FinalsLeague;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  date: string; // ISO start time from ESPN
};

type EspnPayload = {
  events?: Array<{
    date?: string;
    status?: { type?: { completed?: boolean } };
    competitions?: Array<{
      competitors?: Array<{
        homeAway?: "home" | "away";
        score?: string;
        team?: { displayName?: string };
      }>;
    }>;
  }>;
};

/** YYYYMMDD in UTC — the format ESPN's `?dates=` param expects. */
export function yyyymmddUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Fetch completed finals for a league on a given UTC day. [] on any failure. */
export async function fetchFinalsForDay(
  league: FinalsLeague,
  yyyymmdd: string,
): Promise<GameFinal[]> {
  const url = `${ESPN_SCOREBOARD[league]}?dates=${yyyymmdd}`;
  let data: EspnPayload;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    data = (await res.json()) as EspnPayload;
  } catch {
    return [];
  }
  const out: GameFinal[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.status?.type?.completed) continue;
    const cs = ev.competitions?.[0]?.competitors ?? [];
    const home = cs.find((c) => c.homeAway === "home");
    const away = cs.find((c) => c.homeAway === "away");
    if (!home?.team?.displayName || !away?.team?.displayName) continue;
    const hs = parseInt(home.score ?? "", 10);
    const as = parseInt(away.score ?? "", 10);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;
    out.push({
      league,
      homeTeam: home.team.displayName,
      awayTeam: away.team.displayName,
      homeScore: hs,
      awayScore: as,
      date: ev.date ?? "",
    });
  }
  return out;
}

/**
 * Fetch finals across the ±1-day window around a target date (covers the
 * ET/UTC boundary slip on late games), de-duplicated. One network call per day.
 */
export async function fetchFinalsAround(
  league: FinalsLeague,
  target: Date,
): Promise<GameFinal[]> {
  const seen = new Set<string>();
  const all: GameFinal[] = [];
  for (const offset of [-1, 0, 1]) {
    const d = new Date(target);
    d.setUTCDate(d.getUTCDate() + offset);
    for (const f of await fetchFinalsForDay(league, yyyymmddUtc(d))) {
      const key = `${f.homeTeam}::${f.awayTeam}::${f.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(f);
    }
  }
  return all;
}

// A pick from time `gameTimeMs` can only grade against a final whose ESPN date
// is within this window — stops a repeat-matchup (MLB series, NBA back-to-back)
// from grading against the wrong day's score.
const PROXIMITY_MS = 36 * 60 * 60 * 1000;

/**
 * Find the ESPN final that is the same game as (matchup, team @ gameTimeMs).
 * Requires BOTH teams in the matchup AND the picked team to be one of them AND
 * the start times within 36h. Returns null if no confident match.
 */
export function findFinalForMatchup(
  matchup: string,
  team: string,
  gameTimeMs: number,
  finals: GameFinal[],
): GameFinal | null {
  for (const f of finals) {
    const bothInMatchup =
      teamMatches(f.homeTeam, matchup) && teamMatches(f.awayTeam, matchup);
    if (!bothInMatchup) continue;
    const teamIsOne =
      teamMatches(f.homeTeam, team) || teamMatches(f.awayTeam, team);
    if (!teamIsOne) continue;
    if (f.date) {
      const ft = new Date(f.date).getTime();
      if (Number.isFinite(ft) && Number.isFinite(gameTimeMs)) {
        if (Math.abs(ft - gameTimeMs) >= PROXIMITY_MS) continue;
      }
    }
    return f;
  }
  return null;
}

export type MoneylineResult = "won" | "lost" | "void";

/** Grade a moneyline bet on `team` against a final. void on a tie (bad data). */
export function gradeMoneyline(team: string, final: GameFinal): MoneylineResult | null {
  const pickedHome = teamMatches(final.homeTeam, team);
  const pickedAway = teamMatches(final.awayTeam, team);
  if (!pickedHome && !pickedAway) return null;
  if (final.homeScore === final.awayScore) return "void"; // NBA/MLB don't tie
  const homeWon = final.homeScore > final.awayScore;
  if (pickedHome) return homeWon ? "won" : "lost";
  return homeWon ? "lost" : "won";
}
