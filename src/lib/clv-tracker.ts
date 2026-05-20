// CLV (Closing Line Value) tracker — captures the closing odds for each
// pending pick and stores the delta as the truest measure of edge quality.
//
// Closing odds are computed as the BEST PRICE across US books at close,
// mirroring how the analyst picks (best line, not consensus). Comparing
// best-open vs median-close produces a structurally negative CLV even when
// the line never moves, which is what we want to avoid.
//
// Strategy:
//   - Find AgentPick rows where clvCents IS NULL and gameDate is within the
//     last 6 hours (window catches games starting ~now)
//   - For each pick, query The Odds API for the same league and find the
//     matching event by team name
//   - Compute clvCents = pickedOdds - bestClosingOdds  (positive = we beat the close)
//   - Update AgentPick atomically

import { prisma } from "./prisma";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4/sports";
const LEAGUE_TO_SPORT: Record<string, string> = {
  NBA: "basketball_nba",
  MLB: "baseball_mlb",
  NCAAB: "basketball_ncaab",
};

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

async function fetchClosingOdds(league: string): Promise<RawOddsEvent[]> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.warn("THE_ODDS_API_KEY not set — skipping closing-odds fetch");
    return [];
  }
  const sport = LEAGUE_TO_SPORT[league];
  if (!sport) return [];
  const url = `${ODDS_API_BASE}/${sport}/odds?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=american`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends-clv/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`Odds API returned ${res.status} for ${sport}`);
      return [];
    }
    return (await res.json()) as RawOddsEvent[];
  } catch (err) {
    console.warn(`fetchClosingOdds failed for ${league}:`, err);
    return [];
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
  // Window the run scanned, in minutes relative to now. Useful for verifying
  // the 5-min Vercel cron is actually hitting the right pre-game window.
  windowMinBeforeStart: number;
  windowMaxBeforeStart: number;
};

// Capture closing-line value for picks whose game is starting in the
// `[minBeforeStart, maxBeforeStart]` minute window from now. Default window
// is a tight pre-tip-off slot (2 to 12 min before commence_time) so we get
// the actual closing line, not in-play prices. The Odds API still returns
// h2h after a game starts, but the prices are live in-play odds — capturing
// then would give a structurally negative CLV and corrupt the funding gate.
//
// Designed to be called every 5 minutes via Vercel Cron (`/api/cron/clv-capture`).
// At 5-min cadence with a 10-min capture window, each pending pick has two
// chances to be captured before going in-play.
export async function captureClv(
  opts: { minBeforeStart?: number; maxBeforeStart?: number } = {}
): Promise<ClvCaptureResult> {
  const minBeforeStart = opts.minBeforeStart ?? 2;
  const maxBeforeStart = opts.maxBeforeStart ?? 12;

  const result: ClvCaptureResult = {
    ranAt: new Date().toISOString(),
    pendingChecked: 0,
    clvCaptured: 0,
    unmatched: 0,
    errors: [],
    averageClvCents: null,
    windowMinBeforeStart: minBeforeStart,
    windowMaxBeforeStart: maxBeforeStart,
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
    const events = await fetchClosingOdds(league);
    if (events.length === 0) {
      result.errors.push(`${league}: no events from Odds API`);
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
