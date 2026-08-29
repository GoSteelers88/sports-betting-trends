// site-slate.ts — the NFL week board the SITE renders (dashboard NflWeek
// section). Pure transform from the Pinnacle sharp scrape to a committed
// data/processed/nfl-slate.json.
//
// This is a DISPLAY surface, deliberately outside the agent pipeline: the NFL
// quarantine (no AgentPick / ModelPickSnapshot / Turso / IN_SCOPE_LEAGUES) is
// permanent, and NFL picks live ONLY on /nfl, the receipts page. What the
// dashboard gets is the sharp market itself: Pinnacle main lines plus the
// de-vigged fair win probability (power method — the same devig the receipts
// ledger uses), refreshed daily for free.

import { devigTwoWay } from "../nfl-devig";

/** The slice of scrape-pinnacle's SharpEvent this builder reads — declared
 *  here (not imported from scripts/) so the lib never depends on a script. */
export interface SharpEventLike {
  commence_time: string;
  home_team: string;
  away_team: string;
  moneyline?: { home: number; away: number };
  spread?: { point: number; home: number; away: number };
  total?: { point: number; over: number; under: number };
}

export interface NflSlateGame {
  kickoffUtc: string;
  home_team: string; // Odds-API-style keys so the injury wire's slate scoping
  away_team: string; // (SlateOddsFile.events) can read this file unchanged
  moneyline: { home: number; away: number } | null;
  spread: { point: number; home: number; away: number } | null;
  total: { point: number; over: number; under: number } | null;
  /** De-vigged (power) fair win probabilities from the sharp moneyline. */
  fairHomeProb: number | null;
  fairAwayProb: number | null;
}

export interface NflSlate {
  generatedAt: string;
  source: "pinnacle";
  windowStartUtc: string;
  windowEndUtc: string;
  gameCount: number;
  games: NflSlateGame[];
  /** Alias of games for SlateOddsFile compatibility (injury-wire scoping). */
  events: Array<{ home_team: string; away_team: string }>;
}

/** The board shows THE NEXT NFL WEEK, not a fixed calendar window: from
 *  `now − 6h` (games in progress) through 6.5 days after the earliest
 *  upcoming kickoff. Mid-season that is exactly the current Thu→Mon slate;
 *  before week 1 it shows the opening week instead of sitting empty until
 *  the calendar catches up. */
export const SLATE_LOOKBACK_MS = 6 * 3600_000;
export const SLATE_WEEK_SPAN_MS = 6.5 * 24 * 3600_000;

export function buildNflSlate(events: SharpEventLike[], nowMs: number): NflSlate {
  const start = nowMs - SLATE_LOOKBACK_MS;
  const upcoming = events
    .map((e) => Date.parse(e.commence_time))
    .filter((t) => Number.isFinite(t) && t >= start);
  const anchor = upcoming.length ? Math.min(...upcoming) : nowMs;
  const end = anchor + SLATE_WEEK_SPAN_MS;
  const games: NflSlateGame[] = events
    .filter((e) => {
      const t = Date.parse(e.commence_time);
      return Number.isFinite(t) && t >= start && t <= end;
    })
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
    .map((e) => {
      let fairHomeProb: number | null = null;
      let fairAwayProb: number | null = null;
      if (e.moneyline) {
        // devigTwoWay returns the fair probability of its FIRST argument.
        fairHomeProb = devigTwoWay(e.moneyline.home, e.moneyline.away).byMethod.power;
        fairAwayProb = 1 - fairHomeProb;
      }
      return {
        kickoffUtc: e.commence_time,
        home_team: e.home_team,
        away_team: e.away_team,
        moneyline: e.moneyline ?? null,
        spread: e.spread ?? null,
        total: e.total ?? null,
        fairHomeProb,
        fairAwayProb,
      };
    });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    source: "pinnacle",
    windowStartUtc: new Date(start).toISOString(),
    windowEndUtc: new Date(end).toISOString(),
    gameCount: games.length,
    games,
    events: games.map((g) => ({ home_team: g.home_team, away_team: g.away_team })),
  };
}
