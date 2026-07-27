// CLV (Closing Line Value) tracker — captures the closing odds for each
// pending pick and stores the delta as the truest measure of edge quality.
//
// Closing odds are computed as the BEST PRICE across US books at close,
// mirroring how the analyst picks (best line, not consensus). Same source
// as the analyst's picks (scrape-odds.ts → FanDuel + Bovada), so CLV is
// apples-to-apples instead of comparing a best-line pick to a consensus
// close.
//
// Strategy (CONVERGENCE-TO-CLOSE):
//   - Find AgentPick rows where clvFinal = false and gameDate is within the
//     scan window (from maxBeforeStart pre-tip through a grace period post-tip)
//   - Read pre-scraped FD+Bovada odds from data/processed/latest-odds-api-{sportKey}.json
//     (refreshed by the CLV workflow immediately before each capture)
//   - Compute clvProbPoints in PROBABILITY space (positive = we took a longer
//     price than the close). NOT `pickedOdds - closingOdds`: American odds are
//     discontinuous at ±100, so raw subtraction turns a 1.5-point move into
//     "206¢". clvCents is still written alongside, but only as a deprecated
//     legacy reading — nothing decides on it.
//   - On every sweep, overwrite the reading ONLY when it is strictly
//     closer to tip than the stored one — the closeness gate lives in the WHERE
//     clause so it is atomic against concurrent sweeps
//   - Freeze the value (clvFinal = true) only once the game goes in-play; we
//     never let an in-play price land as the "close"

import fs from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";
import { clvProbPoints } from "./devig";

// Exported so the scope-invariant test can assert every IN_SCOPE_LEAGUES entry
// is CLV-accountable (has a sport key → closing-odds file). A missing entry
// means picks in that league count toward the trial's sample/ROI but never get
// CLV captured — the exact contamination WNBA was stripped for in 2026-05.
export const LEAGUE_TO_SPORT: Record<string, string> = {
  NBA: "basketball_nba",
  WNBA: "basketball_wnba",
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
  averageClvProbPoints: number | null;
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
//
// CONVERGENCE-TO-CLOSE semantics (fixed 2026-06-11): each sweep RE-READS every
// non-finalized pick and overwrites the CLV reading only if it is closer to
// tip than the stored one. The reading is finalized (frozen) once the pick goes
// in-play (now >= gameDate): the last pre-tip reading IS the close, and we never
// let an in-play price land. We deliberately do NOT freeze on a "tight closing
// window" — that window can be narrower than the sweep interval, so a sweep
// might never land inside it; finalizing strictly on in-play is robust to any
// sweep cadence. This stops the old bug where the FIRST sweep (~85 min pre-tip)
// froze an opening-ish line as the "closing" line and corrupted the funding gate.
export async function captureClv(
  opts: { minBeforeStart?: number; maxBeforeStart?: number } = {}
): Promise<ClvCaptureResult> {
  const minBeforeStart = opts.minBeforeStart ?? 10;
  const maxBeforeStart = opts.maxBeforeStart ?? 90;
  // After tip, keep scanning a pick for this long so a post-tip sweep can
  // FINALIZE its stored pre-tip reading. Comfortably wider than the ~20-min
  // sweep interval so at least one sweep always catches the in-play transition.
  const POST_TIP_GRACE_MIN = 180;

  const result: ClvCaptureResult = {
    ranAt: new Date().toISOString(),
    pendingChecked: 0,
    clvCaptured: 0,
    unmatched: 0,
    errors: [],
    averageClvProbPoints: null,
    windowMinBeforeStart: minBeforeStart,
    windowMaxBeforeStart: maxBeforeStart,
    oddsFileAgeMinutes: {},
  };

  const now = Date.now();
  // Re-read picks anywhere from `maxBeforeStart` minutes pre-tip through
  // `POST_TIP_GRACE_MIN` minutes past tip, so a pick that first appeared at
  // ~85 min keeps getting tighter readings down to tip, and a post-tip sweep
  // can still FINALIZE its last pre-tip reading without writing the in-play price.
  const earliest = new Date(now + maxBeforeStart * 60 * 1000);
  const latestPostTip = new Date(now - POST_TIP_GRACE_MIN * 60 * 1000);
  let pending: Awaited<ReturnType<typeof prisma.agentPick.findMany>>;
  try {
    pending = await prisma.agentPick.findMany({
      where: {
        clvFinal: false,
        gameDate: { lte: earliest, gte: latestPostTip },
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
      const minutesBeforeTip = Math.round((pick.gameDate.getTime() - now) / 60_000);
      const inPlay = minutesBeforeTip <= 0;

      // Once the game has started, no better pre-tip reading is possible: freeze
      // whatever we have (which may be null if we never matched it) and stop
      // re-scanning the pick. We NEVER overwrite clvCents with an in-play price.
      if (inPlay) {
        try {
          // updateMany so we can gate on clvFinal (non-unique) — no-op if a
          // concurrent sweep already froze it.
          await prisma.agentPick.updateMany({
            where: { id: pick.id, clvFinal: false },
            data: { clvFinal: true },
          });
        } catch {
          /* already finalized by a concurrent sweep — fine */
        }
        continue;
      }

      // Find the event matching pick.matchup
      const ev = events.find(
        e => teamMatches(e.home_team, pick.matchup) || teamMatches(e.away_team, pick.matchup)
      );
      if (!ev) {
        result.unmatched++;
        // Majors: name the pick so "unmatched: N" is debuggable from logs alone.
        console.warn(
          `[clv-capture] unmatched pick ${pick.id} (${pick.matchup}) — no event in ${league} closing-odds file`,
        );
        continue;
      }
      // Find the side we picked — match analyst's "best line" selection logic
      const closingOdds = bestPriceForTeam(ev, pick.selection);
      if (closingOdds === null) {
        result.unmatched++;
        console.warn(
          `[clv-capture] unmatched pick ${pick.id} (${pick.matchup} / ${pick.selection}) — no h2h price for selection`,
        );
        continue;
      }

      // clvCents is the DEPRECATED legacy reading (raw American subtraction —
      // sign is right, magnitude is meaningless across ±100). Kept so the
      // historical column stays continuous and auditable. clvProbPoints is the
      // metric of record; every consumer reads that.
      const clvCents = pick.oddsAmerican - closingOdds;
      const pp = clvProbPoints(pick.oddsAmerican, closingOdds);
      const clvPp = Number.isFinite(pp) ? +pp.toFixed(4) : null;
      try {
        // updateMany so the closeness gate lives in the WHERE clause and is
        // therefore ATOMIC against concurrent sweeps: the write lands only if no
        // reading exists yet, or this one is strictly closer to tip than the
        // stored reading. A stale findMany snapshot can't let a farther reading
        // win, and a row already finalized (in-play) is skipped (count === 0).
        const res = await prisma.agentPick.updateMany({
          where: {
            id: pick.id,
            clvFinal: false,
            OR: [
              { clvReadingMinutesBeforeTip: null },
              { clvReadingMinutesBeforeTip: { gt: minutesBeforeTip } },
            ],
          },
          data: {
            closingOddsAmerican: closingOdds,
            clvCents,
            clvProbPoints: clvPp,
            clvCapturedAt: new Date(),
            clvReadingMinutesBeforeTip: minutesBeforeTip,
            // Never finalize pre-tip — a closer reading may still arrive. The
            // value is frozen only when the game goes in-play (branch above).
          },
        });
        if (res.count > 0) {
          result.clvCaptured++;
          if (clvPp != null) clvDeltas.push(clvPp);
        }
      } catch (err) {
        result.errors.push(`pick ${pick.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (clvDeltas.length > 0) {
    result.averageClvProbPoints = +(
      clvDeltas.reduce((s, c) => s + c, 0) / clvDeltas.length
    ).toFixed(3);
  }

  // CLV-health log line: a stranger should be able to answer "did we capture
  // the close?" from logs alone. One structured line per sweep.
  console.log(
    "[clv-capture] " +
      JSON.stringify({
        ranAt: result.ranAt,
        pending: result.pendingChecked,
        captured: result.clvCaptured,
        unmatched: result.unmatched,
        avgClvProbPoints: result.averageClvProbPoints,
        oddsFileAgeMinutes: result.oddsFileAgeMinutes,
        errors: result.errors.length,
      }),
  );
  return result;
}
