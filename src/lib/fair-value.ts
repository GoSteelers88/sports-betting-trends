// Fair-value / +EV engine — the core of the de-vigged-sharp pivot.
//
// It joins the de-vigged Pinnacle moneyline (fair value) to the best price a
// SOFT book is offering (FanDuel / Bovada via scrape-odds.ts). A bet is +EV
// when a soft book's implied probability sits BELOW the sharp fair value:
//
//     EV% = fairProb · decimal(softPrice) − 1
//
// This is the only retail edge the sharp-betting canon (Miller/Davidow, Wong)
// actually endorses: don't out-model the market, just buy prices the sharp
// book says are mispriced. Positive CLV follows almost by construction because
// the soft price you took beats the consensus the market converges to.
//
// Moneyline only, for now: it needs no line-point reconciliation between books
// and it is exactly what the paper trial measures CLV on.

import fs from "node:fs";
import path from "node:path";
import {
  americanToDecimal,
  americanToImpliedProb,
  noVigFairProbTwoWay,
  expectedValue,
  kellyFraction,
  probToAmerican,
  type DevigMethod,
  DEFAULT_DEVIG_METHOD,
  clvProbPoints,
} from "./devig";
import type { SharpEvent } from "../../scripts/scrape-pinnacle";

const LEAGUE_TO_SPORT: Record<string, string> = {
  NBA: "basketball_nba",
  MLB: "baseball_mlb",
};

// ─────────────────────────────────────────────────────────────────────────────
// Soft-book odds file shape (emitted by scripts/scrape-odds.ts)
// ─────────────────────────────────────────────────────────────────────────────

type SoftOutcome = { name: string; price: number };
type SoftEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    key: string;
    title?: string;
    markets?: Array<{ key: string; outcomes?: SoftOutcome[] }>;
  }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Team matching — token-aware, mirrors the convention used across the app
// (autograder, clv-tracker, bankroll): compare ≥4-char tokens so "New York"
// alone never collapses Yankees and Mets.
// ─────────────────────────────────────────────────────────────────────────────

function normTeam(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function teamMatches(a: string, b: string): boolean {
  const x = normTeam(a);
  const y = normTeam(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tx = x.split(/\s+/).filter((t) => t.length >= 4);
  const ty = y.split(/\s+/).filter((t) => t.length >= 4);
  if (tx.length === 0 || ty.length === 0) return x.includes(y) || y.includes(x);
  const [need, have] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  const haveSet = new Set(have);
  return need.every((t) => haveSet.has(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SoftQuote = { book: string; american: number; impliedProb: number };

export type EvSide = {
  side: "home" | "away";
  team: string;
  /** De-vigged Pinnacle fair probability for this side. */
  fairProb: number;
  /** Fair American line implied by fairProb (the sharp "true" price). */
  fairAmerican: number;
  /** Raw Pinnacle price for this side (with vig). */
  sharpAmerican: number;
  /** Best soft-book price available to actually bet this side. */
  bestSoft: SoftQuote | null;
  /** EV fraction at the best soft price (e.g. 0.035 = +3.5%). null if no soft quote. */
  evPct: number | null;
  /**
   * Sharp-fair CLV in cents = bestSoft − fairAmerican, expressed as the
   * American-points edge of the price you took over fair value. Positive =
   * you bought better than the sharp close.
   */
  clvCents: number | null;
  /** The same edge in PROBABILITY POINTS — the trustworthy magnitude. American
   *  odds are discontinuous at ±100, so clvCents above distorts any move that
   *  crosses the boundary. */
  clvProbPoints: number | null;
  /** Quarter-Kelly stake fraction of bankroll at the best soft price. */
  kelly: number;
  /**
   * True when the EV is implausibly large (> SUSPICIOUS_EV_CEILING). A
   * moneyline that beats the de-vigged Pinnacle line by this much is almost
   * always a data artifact — stale line, wrong-game match, pitcher change,
   * postponement — NOT a real edge. We quarantine these instead of betting
   * them. (Learned the hard way on Kalshi: the "fat edge" is a mirage.)
   */
  suspicious: boolean;
};

// A real moneyline +EV vs a de-vigged Pinnacle line lives in roughly the
// 1–5% band. Anything past this ceiling is treated as a likely data error and
// kept OUT of the playable set. Tunable per-league later.
export const SUSPICIOUS_EV_CEILING = 0.06;

// Two events are the "same game" only if their start times are within this
// window. Without it, team-only matching collapses tonight's game, tomorrow's
// rematch, and both ends of a doubleheader into one — comparing a sharp line
// for one game to a soft line for another (different starting pitchers).
const MATCH_MAX_HOURS = 6;

export type EvGame = {
  league: string;
  commence_time: string;
  matchup: string; // "Away @ Home"
  home_team: string;
  away_team: string;
  overround: number; // Pinnacle's posted margin on this market
  method: DevigMethod;
  sides: EvSide[];
};

export type FairValueBoard = {
  league: string;
  sharpFetchedAt: string | null;
  softFetchedAt: string | null;
  gamesMatched: number;
  sharpGames: number;
  softGames: number;
  unmatched: string[]; // sharp matchups with no soft counterpart
  games: EvGame[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

function readJson<T>(file: string): { data: T; fetchedAt: string | null } | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { data: raw as T, fetchedAt: raw?.fetchedAt ?? null };
  } catch {
    return null;
  }
}

function loadSharp(sportKey: string, dir: string) {
  return readJson<{ events: SharpEvent[] }>(
    path.join(dir, `latest-sharp-pinnacle-${sportKey}.json`),
  );
}

// Soft prices come from two feeds, merged so best-price shopping spans every
// book: scrape-odds.ts (FanDuel + Bovada, free) and ingest-softbooks.ts (The
// Odds API: DK/MGM/ESPN BET/BetRivers/…). For each game we union the books
// from both feeds; the newest fetchedAt of the two is reported.
function loadSoft(sportKey: string, dir: string) {
  const primary = readJson<{ events: SoftEvent[] }>(
    path.join(dir, `latest-odds-api-${sportKey}.json`),
  );
  const extra = readJson<{ events: SoftEvent[] }>(
    path.join(dir, `latest-softbooks-${sportKey}.json`),
  );
  if (!primary && !extra) return null;

  const merged = new Map<string, SoftEvent>();
  const ingest = (events: SoftEvent[] | undefined) => {
    for (const ev of events ?? []) {
      const key = softGameKey(ev);
      const existing = merged.get(key);
      if (existing) {
        existing.bookmakers = [
          ...(existing.bookmakers ?? []),
          ...(ev.bookmakers ?? []),
        ];
      } else {
        merged.set(key, { ...ev, bookmakers: [...(ev.bookmakers ?? [])] });
      }
    }
  };
  ingest(primary?.data.events);
  ingest(extra?.data.events);

  const fetchedAt = [primary?.fetchedAt, extra?.fetchedAt]
    .filter((t): t is string => !!t)
    .sort()
    .pop() ?? null;

  return { data: { events: [...merged.values()] }, fetchedAt };
}

// Merge key: same teams (order-independent) on the same calendar day. Good
// enough to union two feeds; the sharp↔soft match later still enforces a
// 6-hour time window per game.
function softGameKey(ev: SoftEvent): string {
  const day = (ev.commence_time ?? "").slice(0, 10);
  const pair = [normTeam(ev.home_team), normTeam(ev.away_team)].sort().join("|");
  return `${day}|${pair}`;
}

// Best (highest-payout) soft moneyline price for a team across all soft books.
// For American odds, numerically larger is always better for the bettor.
export function bestSoftQuote(ev: SoftEvent, team: string): SoftQuote | null {
  let best: SoftQuote | null = null;
  for (const book of ev.bookmakers ?? []) {
    for (const m of book.markets ?? []) {
      if (m.key !== "h2h") continue;
      for (const o of m.outcomes ?? []) {
        if (!teamMatches(o.name, team)) continue;
        if (typeof o.price !== "number") continue;
        if (!best || o.price > best.american) {
          best = {
            book: book.key,
            american: o.price,
            impliedProb: americanToImpliedProb(o.price),
          };
        }
      }
    }
  }
  return best;
}

// Find the soft event that is the SAME game as `sharp`: both teams must match
// AND the start times must be within MATCH_MAX_HOURS. Among candidates, take
// the closest in time — this disambiguates doubleheaders and day-apart
// rematches that team-only matching would wrongly collapse together.
export function closestSoftMatch(
  sharp: SharpEvent,
  softEvents: SoftEvent[],
): SoftEvent | null {
  const sharpT = new Date(sharp.commence_time).getTime();
  const maxMs = MATCH_MAX_HOURS * 3_600_000;
  let best: SoftEvent | null = null;
  let bestDelta = Infinity;
  for (const s of softEvents) {
    const teamsMatch =
      (teamMatches(s.home_team, sharp.home_team) &&
        teamMatches(s.away_team, sharp.away_team)) ||
      (teamMatches(s.home_team, sharp.away_team) &&
        teamMatches(s.away_team, sharp.home_team));
    if (!teamsMatch) continue;
    const softT = new Date(s.commence_time).getTime();
    // If either timestamp is unparseable, fall back to a team-only match but
    // only when nothing better has been found.
    if (!Number.isFinite(sharpT) || !Number.isFinite(softT)) {
      if (best === null) best = s;
      continue;
    }
    const delta = Math.abs(softT - sharpT);
    if (delta <= maxMs && delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: compute the EV game for one sharp event against one soft event
// ─────────────────────────────────────────────────────────────────────────────

export function computeEvGame(
  league: string,
  sharp: SharpEvent,
  soft: SoftEvent | null,
  method: DevigMethod = DEFAULT_DEVIG_METHOD,
): EvGame | null {
  if (!sharp.moneyline) return null;
  const devig = noVigFairProbTwoWay(
    sharp.moneyline.home,
    sharp.moneyline.away,
    method,
  );
  if (!devig) return null;

  const mkSide = (
    side: "home" | "away",
    team: string,
    fairProb: number,
    sharpAmerican: number,
  ): EvSide => {
    const bestSoft = soft ? bestSoftQuote(soft, team) : null;
    const evPct = bestSoft ? expectedValue(fairProb, bestSoft.american) : null;
    const fairAmerican = probToAmerican(fairProb);
    const clvCents =
      bestSoft && Number.isFinite(fairAmerican)
        ? bestSoft.american - fairAmerican
        : null;
    const ppRaw =
      bestSoft && Number.isFinite(fairAmerican)
        ? clvProbPoints(bestSoft.american, fairAmerican)
        : NaN;
    const clvProbPointsValue = Number.isFinite(ppRaw) ? +ppRaw.toFixed(4) : null;
    const kelly = bestSoft ? kellyFraction(fairProb, bestSoft.american) : 0;
    const suspicious = evPct != null && evPct > SUSPICIOUS_EV_CEILING;
    return {
      side,
      team,
      fairProb,
      fairAmerican,
      clvProbPoints: clvProbPointsValue,
      sharpAmerican,
      bestSoft,
      evPct,
      clvCents,
      kelly,
      suspicious,
    };
  };

  return {
    league,
    commence_time: sharp.commence_time,
    matchup: `${sharp.away_team} @ ${sharp.home_team}`,
    home_team: sharp.home_team,
    away_team: sharp.away_team,
    overround: devig.overround,
    method,
    sides: [
      mkSide("home", sharp.home_team, devig.fairA, sharp.moneyline.home),
      mkSide("away", sharp.away_team, devig.fairB, sharp.moneyline.away),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Board: load both feeds, match games, compute EV for the whole slate
// ─────────────────────────────────────────────────────────────────────────────

export function buildFairValueBoard(
  league: "NBA" | "MLB",
  opts: { method?: DevigMethod; dataDir?: string } = {},
): FairValueBoard {
  const method = opts.method ?? DEFAULT_DEVIG_METHOD;
  const dir =
    opts.dataDir ?? path.join(process.cwd(), "data", "processed");
  const sportKey = LEAGUE_TO_SPORT[league];

  const sharpFile = loadSharp(sportKey, dir);
  const softFile = loadSoft(sportKey, dir);

  const sharpEvents = sharpFile?.data.events ?? [];
  const softEvents = softFile?.data.events ?? [];

  const games: EvGame[] = [];
  const unmatched: string[] = [];

  for (const sharp of sharpEvents) {
    if (!sharp.moneyline) continue;
    const soft = closestSoftMatch(sharp, softEvents);

    const game = computeEvGame(league, sharp, soft, method);
    if (!game) continue;
    games.push(game);
    if (!soft) unmatched.push(`${sharp.away_team} @ ${sharp.home_team}`);
  }

  games.sort((a, b) => a.commence_time.localeCompare(b.commence_time));

  return {
    league,
    sharpFetchedAt: sharpFile?.fetchedAt ?? null,
    softFetchedAt: softFile?.fetchedAt ?? null,
    gamesMatched: games.filter((g) => g.sides.some((s) => s.bestSoft)).length,
    sharpGames: sharpEvents.length,
    softGames: softEvents.length,
    unmatched,
    games,
  };
}

export type EvOpportunity = EvSide & { matchup: string; commence_time: string };

/**
 * Flatten a board to the PLAYABLE +EV opportunities, sorted by EV descending.
 * `minEvPct` defaults to 0.02 (+2%) — a floor that clears noise and the fact
 * that even Pinnacle's de-vigged line is an estimate, not gospel. Suspicious
 * (too-good-to-be-true) sides are excluded — see `suspiciousOpportunities`.
 */
export function positiveEvOpportunities(
  board: FairValueBoard,
  minEvPct = 0.02,
): EvOpportunity[] {
  const out: EvOpportunity[] = [];
  for (const g of board.games) {
    for (const s of g.sides) {
      if (s.evPct != null && s.evPct >= minEvPct && s.bestSoft && !s.suspicious) {
        out.push({ ...s, matchup: g.matchup, commence_time: g.commence_time });
      }
    }
  }
  out.sort((a, b) => (b.evPct ?? 0) - (a.evPct ?? 0));
  return out;
}

/**
 * The quarantined sides — EV so large it's almost certainly a data artifact
 * (stale/mismatched line, pitcher change, postponement). Surfaced separately
 * so they can be inspected, never silently bet.
 */
export function suspiciousOpportunities(board: FairValueBoard): EvOpportunity[] {
  const out: EvOpportunity[] = [];
  for (const g of board.games) {
    for (const s of g.sides) {
      if (s.suspicious && s.bestSoft) {
        out.push({ ...s, matchup: g.matchup, commence_time: g.commence_time });
      }
    }
  }
  out.sort((a, b) => (b.evPct ?? 0) - (a.evPct ?? 0));
  return out;
}
