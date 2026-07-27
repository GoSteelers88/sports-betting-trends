// CLV-proof harness — measures whether "take the best soft price" systematically
// beats the SHARP CLOSE, before a single real dollar is risked.
//
// A single pre-game snapshot shows ~0 EV vs the current Pinnacle line (the
// market is converged). The open question the de-vigged-sharp thesis rests on
// is whether taking the best available price EARLY captures positive CLV — i.e.
// the line moves toward you by close. This harness accumulates that evidence:
//
//   ENTRY  — first time a game is seen inside the betting window, lock in the
//            best soft price per side + the de-vigged Pinnacle fair at that
//            moment. This is the "bet" we are simulating.
//   CLOSE  — every later run refreshes the latest de-vigged Pinnacle fair until
//            the game starts; the last one before commence is the close.
//   SETTLE — once the game has started, finalize: did the entry price beat the
//            closing fair line? (beatClose) and by how much (clvCents, evVsClose).
//
// Storage is a plain JSON log (data/processed/clv-proof-log.json) so it is
// inspectable and needs no migration. Promote to Turso once the signal is real.

import fs from "node:fs";
import path from "node:path";
import {
  americanToImpliedProb,
  expectedValue,
  probToAmerican,
  clvProbPoints,
} from "./devig";
import {
  buildFairValueBoard,
  type FairValueBoard,
  type EvSide,
  type EvGame,
} from "./fair-value";

// Only lock an ENTRY for games starting within this lead-time window. Too far
// out and Pinnacle hasn't posted a real line; past tip-off the price is live.
const ENTRY_MIN_HOURS = 0.25;
const ENTRY_MAX_HOURS = 14;

// The real playable floor: a side is a "would-bet" play only when its entry
// price beats the de-vigged sharp line by at least this much (matches the
// grader's 2% sane minimum). Every side is still LOGGED regardless — the
// floor only sets the `wouldBet` flag, so `would_bet_only` in the report
// reflects the actual strategy, not "any non-negative EV".
export const PLAYABLE_FLOOR = 0.02;

export type ClvProofEntry = {
  id: string; // `${league}|${gameDay}|${pair}|${side}`
  league: string;
  matchup: string;
  commenceTime: string;
  side: "home" | "away";
  team: string;

  // ENTRY — locked once, on first sighting in the window.
  entryAt: string;
  entryHoursToGame: number;
  entrySoftPrice: number; // American
  entrySoftBook: string;
  entrySharpFairProb: number;
  entrySharpFairAmerican: number;
  entryEvVsSharp: number; // EV% vs the capture-time Pinnacle line
  /** Would the strategy actually bet this side at entry? (beats sharp by floor) */
  wouldBet: boolean;

  // CLOSE — refreshed every run until commence.
  closeAt: string;
  closeSharpFairProb: number;
  closeSharpFairAmerican: number;

  // SETTLE — computed once the game has started.
  settled: boolean;
  /** DEPRECATED — raw American subtraction (entrySoftPrice − closeSharpFairAmerican).
   *  Sign is right, magnitude is not: American odds are discontinuous at ±100,
   *  so a 1.5-point move that crosses the boundary reads as "206¢". Retained for
   *  log continuity. Read clvProbPoints. */
  clvCents: number | null;
  /** CLV in PROBABILITY POINTS (>0 = we took a longer price than the close). */
  clvProbPoints: number | null;
  beatClose: boolean | null; // impliedProb(entry) < closeSharpFairProb
  evVsClose: number | null; // closeSharpFairProb · dec(entry) − 1
};

type Store = { updatedAt: string; entries: ClvProofEntry[] };

function storePath(dir: string): string {
  return path.join(dir, "clv-proof-log.json");
}

export function loadStore(dir: string): Store {
  const p = storePath(dir);
  if (!fs.existsSync(p)) return { updatedAt: "", entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Store;
    return { updatedAt: raw.updatedAt ?? "", entries: raw.entries ?? [] };
  } catch {
    return { updatedAt: "", entries: [] };
  }
}

export function saveStore(dir: string, store: Store, nowIso: string): void {
  fs.writeFileSync(
    storePath(dir),
    JSON.stringify({ updatedAt: nowIso, entries: store.entries }, null, 2),
  );
}

function entryId(g: EvGame, s: EvSide): string {
  const day = g.commence_time.slice(0, 10);
  const pair = [g.home_team, g.away_team]
    .map((t) => t.toLowerCase().replace(/[^a-z]/g, ""))
    .sort()
    .join("");
  return `${g.league}|${day}|${pair}|${s.side}`;
}

export type CaptureSummary = {
  nowIso: string;
  leaguesRun: string[];
  newEntries: number;
  refreshedCloses: number;
  settled: number;
  skippedSuspicious: number;
  boards: Record<string, { sharpGames: number; softGames: number }>;
};

/**
 * One tick of the harness: refresh boards, lock new entries, refresh closes,
 * settle started games. Pure given (board, store, now) so it is testable.
 */
export function tick(
  boards: Array<{ league: string; board: FairValueBoard }>,
  store: Store,
  nowMs: number,
  floor = PLAYABLE_FLOOR, // log CLV for ALL sides; wouldBet flags the ≥floor ones
): CaptureSummary {
  const nowIso = new Date(nowMs).toISOString();
  const byId = new Map(store.entries.map((e) => [e.id, e]));
  const summary: CaptureSummary = {
    nowIso,
    leaguesRun: boards.map((b) => b.league),
    newEntries: 0,
    refreshedCloses: 0,
    settled: 0,
    skippedSuspicious: 0,
    boards: {},
  };

  for (const { league, board } of boards) {
    summary.boards[league] = {
      sharpGames: board.sharpGames,
      softGames: board.softGames,
    };
    for (const g of board.games) {
      const commenceMs = new Date(g.commence_time).getTime();
      if (!Number.isFinite(commenceMs)) continue;
      const hoursToGame = (commenceMs - nowMs) / 3_600_000;

      for (const s of g.sides) {
        if (!s.bestSoft || s.evPct == null) continue;
        if (s.suspicious) {
          summary.skippedSuspicious++;
          continue;
        }
        const id = entryId(g, s);
        const existing = byId.get(id);

        if (!existing) {
          // Only create an entry while the game sits in the betting window.
          if (hoursToGame < ENTRY_MIN_HOURS || hoursToGame > ENTRY_MAX_HOURS) {
            continue;
          }
          const e: ClvProofEntry = {
            id,
            league,
            matchup: g.matchup,
            commenceTime: g.commence_time,
            side: s.side,
            team: s.team,
            entryAt: nowIso,
            entryHoursToGame: +hoursToGame.toFixed(2),
            entrySoftPrice: s.bestSoft.american,
            entrySoftBook: s.bestSoft.book,
            entrySharpFairProb: s.fairProb,
            entrySharpFairAmerican: s.fairAmerican,
            entryEvVsSharp: +s.evPct.toFixed(4),
            wouldBet: s.evPct >= floor,
            closeAt: nowIso,
            closeSharpFairProb: s.fairProb,
            closeSharpFairAmerican: s.fairAmerican,
            settled: false,
            clvCents: null,
            clvProbPoints: null,
            beatClose: null,
            evVsClose: null,
          };
          store.entries.push(e);
          byId.set(id, e);
          summary.newEntries++;
        } else if (!existing.settled) {
          // Refresh the close with the latest sharp fair (pre-game only).
          if (nowMs < commenceMs) {
            existing.closeAt = nowIso;
            existing.closeSharpFairProb = s.fairProb;
            existing.closeSharpFairAmerican = s.fairAmerican;
            summary.refreshedCloses++;
          }
        }
      }
    }
  }

  // Settle anything whose game has started and isn't settled yet.
  for (const e of store.entries) {
    if (e.settled) continue;
    const commenceMs = new Date(e.commenceTime).getTime();
    if (!Number.isFinite(commenceMs) || nowMs < commenceMs) continue;
    settleEntry(e);
    summary.settled++;
  }

  return summary;
}

export function settleEntry(e: ClvProofEntry): void {
  const entryImplied = americanToImpliedProb(e.entrySoftPrice);
  const closeFairAmerican = Number.isFinite(e.closeSharpFairAmerican)
    ? e.closeSharpFairAmerican
    : probToAmerican(e.closeSharpFairProb);
  e.clvCents = Number.isFinite(closeFairAmerican)
    ? e.entrySoftPrice - closeFairAmerican
    : null;
  const pp = clvProbPoints(e.entrySoftPrice, closeFairAmerican);
  e.clvProbPoints = Number.isFinite(pp) ? +pp.toFixed(4) : null;
  // Beat the close = the price you took implies a LOWER probability than the
  // sharp closing fair → you bought a better number than the market settled on.
  e.beatClose = Number.isFinite(entryImplied)
    ? entryImplied < e.closeSharpFairProb
    : null;
  e.evVsClose = +expectedValue(e.closeSharpFairProb, e.entrySoftPrice).toFixed(4);
  e.settled = true;
}

export type ClvReport = {
  totalEntries: number;
  settled: number;
  pending: number;
  byScope: Record<
    string,
    {
      n: number;
      beatCloseRate: number; // fraction with beatClose=true
      avgClvProbPoints: number;
      avgEvVsClose: number; // mean EV% vs the sharp close
    }
  >;
};

function summarize(entries: ClvProofEntry[]): ClvReport["byScope"][string] {
  const n = entries.length;
  if (n === 0) return { n: 0, beatCloseRate: 0, avgClvProbPoints: 0, avgEvVsClose: 0 };
  const beats = entries.filter((e) => e.beatClose).length;
  const clv = entries.reduce((s, e) => s + (e.clvProbPoints ?? 0), 0) / n;
  const ev = entries.reduce((s, e) => s + (e.evVsClose ?? 0), 0) / n;
  return {
    n,
    beatCloseRate: +(beats / n).toFixed(4),
    avgClvProbPoints: +clv.toFixed(3),
    avgEvVsClose: +ev.toFixed(4),
  };
}

/**
 * Aggregate the settled record. Scopes: ALL settled, settled∩wouldBet (the
 * plays the strategy would actually have made), and per-league.
 */
export function report(store: Store): ClvReport {
  const settled = store.entries.filter((e) => e.settled);
  const byScope: ClvReport["byScope"] = {
    all_settled: summarize(settled),
    would_bet_only: summarize(settled.filter((e) => e.wouldBet)),
  };
  for (const league of new Set(settled.map((e) => e.league))) {
    byScope[`league_${league}`] = summarize(
      settled.filter((e) => e.league === league),
    );
  }
  return {
    totalEntries: store.entries.length,
    settled: settled.length,
    pending: store.entries.length - settled.length,
    byScope,
  };
}

/**
 * Convenience wrapper used by the CLI: build live boards, run a tick, persist.
 */
export function runTick(opts: { dataDir?: string; nowMs?: number } = {}): {
  summary: CaptureSummary;
  report: ClvReport;
} {
  const dir = opts.dataDir ?? path.join(process.cwd(), "data", "processed");
  const nowMs = opts.nowMs ?? Date.now();
  const boards = [
    { league: "MLB" as const, board: buildFairValueBoard("MLB", { dataDir: dir }) },
    { league: "NBA" as const, board: buildFairValueBoard("NBA", { dataDir: dir }) },
  ];
  const store = loadStore(dir);
  const summary = tick(boards, store, nowMs);
  saveStore(dir, store, summary.nowIso);
  return { summary, report: report(store) };
}
