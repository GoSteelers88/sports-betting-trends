// CLV (Closing Line Value) tracker — captures the closing odds for each
// pending pick and stores the delta as the truest measure of edge quality.
//
// Closing odds are computed as the BEST PRICE across US books at close,
// mirroring how the analyst picks (best line, not consensus). Same source
// as the analyst's picks (scrape-odds.ts → FanDuel + Bovada), so CLV is
// apples-to-apples instead of comparing a best-line pick to a consensus
// close.
//
// Strategy:
//   - Find AgentPick rows where clvCents IS NULL and gameDate is within the
//     configured pre-game window
//   - Read pre-scraped FD+Bovada odds from data/processed/latest-odds-api-{sportKey}.json
//     (refreshed by the CLV workflow immediately before each capture)
//   - Compute clvCents = pickedOdds - bestClosingOdds (positive = we beat the close)
//   - Update AgentPick atomically

import fs from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";

const LEAGUE_TO_SPORT: Record<string, string> = {
  NBA: "basketball_nba",
  MLB: "baseball_mlb",
  NCAAB: "basketball_ncaab",
};

// File data is considered usable for CLV if it's been refreshed within this
// window. Beyond it, we still capture but record the staleness so we can
// audit later. The CLV workflow scrapes immediately before each capture, so
// in normal operation this stays well under 2 minutes.
const ODDS_FILE_STALE_MINUTES = 30;

type RawOddsEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    key: string;
    markets?: Array<{
      key: string;
      outcomes?: Array<{ name: string; price: number }>;
    }>;
  }>;
};

type OddsFilePayload = {
  fetchedAt: string;
  league: string;
  eventCount: number;
  events: RawOddsEvent[];
};

// Token-aware match (avoids "New York" → both Yankees and Mets)
function teamMatches(needle: string, hay: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[.'-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const a = norm(needle);
  const b = norm(hay);
  if (!a || !b) return false;
  if (a === b) return true;
  const tokensA = a.split(/\s+/).filter(t => t.length >= 4);
  const tokensB = b.split(/\s+/).filter(t => t.length >= 4);
  if (tokensA.length === 0 || tokensB.length === 0) return a.includes(b) || b.includes(a);
  const [need, have] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const haveSet = new Set(have);
  return need.every(t => haveSet.has(t));
}

function loadClosingOdds(
  league: string,
): { events: RawOddsEvent[]; ageMinutes: number | null; missing: boolean } {
  const sport = LEAGUE_TO_SPORT[league];
  if (!sport) return { events: [], ageMinutes: null, missing: true };

  const filePath = path.join(
    process.cwd(),
    "data",
    "processed",
    `latest-odds-api-${sport}.json`,
  );

  if (!fs.existsSync(filePath)) {
    console.warn(`closing-odds file missing for ${league}: ${filePath}`);
    return { events: [], ageMinutes: null, missing: true };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw) as OddsFilePayload;
    const fetchedAt = new Date(payload.fetchedAt).getTime();
    const ageMinutes = (Date.now() - fetchedAt) / 60_000;
    if (ageMinutes > ODDS_FILE_STALE_MINUTES) {
      console.warn(
        `closing-odds file for ${league} is ${ageMinutes.toFixed(1)} min old — capture may use stale lines`,
      );
    }
    return { events: payload.events ?? [], ageMinutes, missing: false };
  } catch (err) {
    console.warn(`loadClosingOdds failed for ${league}:`, err);
    return { events: [], ageMinutes: null, missing: true };
  }
}

// Best American price across all US books for the bettor. Math.max works
// directly because for American odds, numerically-larger is always better
// for the bettor: +150 > +140 (bigger payout), -105 > -120 (less risk),
// and any positive > any negative.
function bestPriceForTeam(ev: RawOddsEvent, team: string): number | null {
  const prices: number[] = [];
  for (const book of ev.bookmakers ?? []) {
    for (const m of book.markets ?? []) {
      if (m.key !== "h2h") continue;
      for (const o of m.outcomes ?? []) {
        if (teamMatches(o.name, team)) prices.push(o.price);
      }
    }
  }
  return prices.length > 0 ? Math.max(...prices) : null;
}

export type ClvCaptureResult = {
  ranAt: string;
  pendingChecked: number;
  clvCaptured: number;
  unmatched: number;
  errors: string[];
  averageClvCents: number | null;
  // Window the run scanned, in minutes relative to now.
  windowMinBeforeStart: number;
  windowMaxBeforeStart: number;
  // Age in minutes of the odds files we read, per league. Useful for
  // auditing whether the scrape-then-capture pipeline is healthy.
  oddsFileAgeMinutes: Record<string, number | null>;
};

// Capture closing-line value for picks whose game is starting in the
// `[minBeforeStart, maxBeforeStart]` minute window from now. Default window
// covers the last 90 minutes pre-tip-off, which lines up with the GHA-driven
// scrape-then-capture schedule (every ~15-30 min during peak game hours).
// Both bounds must remain positive — past commence_time, the scraped odds
// start to show in-play prices and would corrupt the funding-gate signal.
export async function captureClv(
  opts: { minBeforeStart?: number; maxBeforeStart?: number } = {}
): Promise<ClvCaptureResult> {
  const minBeforeStart = opts.minBeforeStart ?? 10;
  const maxBeforeStart = opts.maxBeforeStart ?? 90;

  const result: ClvCaptureResult = {
    ranAt: new Date().toISOString(),
    pendingChecked: 0,
    clvCaptured: 0,
    unmatched: 0,
    errors: [],
    averageClvCents: null,
    windowMinBeforeStart: minBeforeStart,
    windowMaxBeforeStart: maxBeforeStart,
    oddsFileAgeMinutes: {},
  };

  const now = Date.now();
  const since = new Date(now + minBeforeStart * 60 * 1000);
  const until = new Date(now + maxBeforeStart * 60 * 1000);
  let pending: Awaited<ReturnType<typeof prisma.agentPick.findMany>>;
  try {
    pending = await prisma.agentPick.findMany({
      where: {
        clvCents: null,
        gameDate: { gte: since, lte: until },
        // Props excluded — prop markets lack the market-making liquidity
        // that makes CLV a reliable edge signal (industry consensus). The
        // dashboard already filters props OUT of CLV stats, so capturing
        // them here just adds noise + Odds API quota cost for no benefit.
        market: { not: "prop" },
      },
    });
  } catch (err) {
    result.errors.push(`DB read: ${err instanceof Error ? err.message : err}`);
    return result;
  }
  result.pendingChecked = pending.length;
  if (pending.length === 0) return result;

  // Group by league to minimize API calls
  const byLeague = new Map<string, typeof pending>();
  for (const p of pending) {
    const list = byLeague.get(p.league) ?? [];
    list.push(p);
    byLeague.set(p.league, list);
  }

  const clvDeltas: number[] = [];

  for (const [league, picks] of byLeague.entries()) {
    const { events, ageMinutes, missing } = loadClosingOdds(league);
    result.oddsFileAgeMinutes[league] = ageMinutes;
    if (missing || events.length === 0) {
      result.errors.push(
        missing
          ? `${league}: closing-odds file missing — run npm run ingest:odds before picks:clv`
          : `${league}: closing-odds file empty`,
      );
      result.unmatched += picks.length;
      continue;
    }
    for (const pick of picks) {
      // Find the event matching pick.matchup
      const ev = events.find(
        e => teamMatches(e.home_team, pick.matchup) || teamMatches(e.away_team, pick.matchup)
      );
      if (!ev) {
        result.unmatched++;
        continue;
      }
      // Find the side we picked — match analyst's "best line" selection logic
      const closingOdds = bestPriceForTeam(ev, pick.selection);
      if (closingOdds === null) {
        result.unmatched++;
        continue;
      }
      const clvCents = pick.oddsAmerican - closingOdds;
      try {
        await prisma.agentPick.update({
          where: { id: pick.id },
          data: {
            closingOddsAmerican: closingOdds,
            clvCents,
            clvCapturedAt: new Date(),
          },
        });
        result.clvCaptured++;
        clvDeltas.push(clvCents);
      } catch (err) {
        result.errors.push(`pick ${pick.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (clvDeltas.length > 0) {
    result.averageClvCents = +(
      clvDeltas.reduce((s, c) => s + c, 0) / clvDeltas.length
    ).toFixed(2);
  }
  return result;
}
