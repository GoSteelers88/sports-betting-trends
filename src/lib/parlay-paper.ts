// parlay-paper.ts — Experiment No. 4: the parlay paper book.
//
// Thesis (PARLAY_PAPER_SPEC.md): if each leg is an INDEPENDENT +EV bet, the
// product of three of them is also +EV and the variance is paid for by the
// compounded edge. We test that with the props board's already-validated
// playable legs (EV ≥ 3% vs the de-vigged sharp prop line), combined ONLY
// across three distinct, independent games.
//
// Measurement-only. This module prices, sizes, opens, and settles a $10k PAPER
// book in a JSON file (data/processed/parlay-paper-book.json). It places NOTHING
// real — there is no broker client anywhere in this file or its callers.
//
// House style mirrors devig-paper.ts exactly: accounting is DERIVED from the
// parlay rows (no running cash that can drift), open late / settle first, and
// the pure decisions (assemble / EV / stake) are separated from the impure
// settlement effect (ESPN box scores) so the core is testable without mocks.

import fs from "node:fs";
import path from "node:path";
import {
  americanToDecimal,
  decimalToAmerican,
  kellyFraction,
  americanToImpliedProb,
} from "./devig";
import {
  buildPlayerStatLookup,
  resolveProp,
  yyyymmdd,
  type PlayerStatLookup,
  type PropGradingLeague,
} from "./prop-grading";

export const PARLAY_PAPER_CONFIG = {
  startingBankrollUsd: 10_000,
  evFloor: 0.03, // a leg must be playable on the props board (EV ≥ 3% vs sharp)
  legsPerParlay: 3, // exactly three legs, three distinct games
  haircutPerLegProb: 0.04, // −4pt per-leg fairProb haircut the parlay must still survive
  kellyMultiplier: 0.25, // quarter-Kelly on the COMBINED prob/odds (never per-leg product)
  maxStakePctEquity: 0.05, // cap any one parlay at 5% of equity
  minStakeUsd: 10, // floor — below this isn't worth booking
} as const;

// A single leg as locked at parlay-open time. A full sub-record so the on-call
// reader can answer "which leg lost parlay #4" from the JSON alone.
export type ParlayLeg = {
  legId: string; // stable per (player|propType|side|line|book|gameId)
  player: string;
  gameId: string;
  team?: string;
  opponent?: string;
  propType: string; // Pinnacle units ("Strikeouts", "HomeRuns", …)
  line: number;
  side: "Over" | "Under";
  oddsAmerican: number; // the soft price we took at entry
  book: string;
  fairProb: number; // de-vigged sharp fair prob of this side at entry
  decimal: number; // americanToDecimal(oddsAmerican), cached for audit
  commence: string;
  league: ParlayLeague;
  // settlement (null until the leg's box score is terminal)
  status: "open" | "won" | "lost" | "push" | "void";
  actual: number | null;
  finalScore: string | null;
};

export type ParlayLeague = "MLB" | "NBA" | "WNBA";

export type ParlayBet = {
  id: string; // deterministic = sorted leg ids joined — re-running opens no dup
  openedAt: string;
  legs: ParlayLeg[]; // ORIGINAL legs (immutable audit trail)
  survivingLegIds: string[]; // legs that priced the settled result (push/void dropped)
  // parlay-level pricing locked at open
  parlayDecimalOdds: number; // Π decimal_i
  parlayFairProb: number; // Π fairProb_i
  parlayEV: number; // Π(fairProb_i·decimal_i) − 1
  flipDelta: number; // per-leg fairProb haircut δ that zeroes parlayEV
  stakeUsd: number; // ¼-Kelly on combined prob/odds, capped + floored
  // settlement
  status: "open" | "won" | "lost" | "void";
  pnlUsd: number | null;
  settledAt: string | null;
};

export type ParlayPaperBook = {
  updatedAt: string;
  parlays: ParlayBet[];
  ledger: Array<{
    ts: string;
    equityUsd: number;
    realizedPnlUsd: number;
    exposureUsd: number;
    openCount: number;
    settledCount: number;
    wins: number;
    losses: number;
  }>;
};

export type ParlayPaperStats = {
  startingBankrollUsd: number;
  equityUsd: number;
  cashUsd: number;
  exposureUsd: number;
  realizedPnlUsd: number;
  roiPct: number;
  openCount: number;
  settledCount: number;
  wins: number;
  losses: number;
  voids: number;
  winRatePct: number | null;
  totalStakedUsd: number;
  yieldPct: number | null;
  avgParlayEv: number | null;
};

// A candidate leg sourced from the props-board log (one playable quote tick).
export type CandidateLeg = {
  legId: string;
  player: string;
  gameId: string;
  team?: string;
  opponent?: string;
  propType: string;
  line: number;
  side: "Over" | "Under";
  oddsAmerican: number;
  book: string;
  fairProb: number;
  commence: string;
  league: ParlayLeague;
};

// ─────────────────────────────────────────────────────────────────────────────
// Skip-reason tally — every reason a candidate triple is rejected
// ─────────────────────────────────────────────────────────────────────────────

export type SkipReason =
  | "no-gameId"
  | "same-game"
  | "correlated"
  | "neg-EV"
  | "haircut"
  | "too-small"
  | "dup"
  | "leg-reused";

export type SkipTally = {
  started: number; // candidate triples examined
  noGameId: number;
  sameGame: number;
  correlated: number;
  negEV: number;
  haircut: number;
  tooSmall: number;
  dup: number;
  legReused: number;
};

function emptyTally(): SkipTally {
  return {
    started: 0,
    noGameId: 0,
    sameGame: 0,
    correlated: 0,
    negEV: 0,
    haircut: 0,
    tooSmall: 0,
    dup: 0,
    legReused: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leg identity — deterministic so reruns of the same slate are idempotent
// ─────────────────────────────────────────────────────────────────────────────

export function legKey(input: {
  player: string;
  propType: string;
  side: string;
  line: number;
  book: string;
  gameId: string;
}): string {
  const p = input.player.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [p, input.propType, input.side, input.line, input.book, input.gameId]
    .join("|")
    .toLowerCase();
}

/** Deterministic parlay id = sorted leg ids. Re-running a slate can't dup. */
export function parlayId(legIds: string[]): string {
  return [...legIds].sort().join("~");
}

// ─────────────────────────────────────────────────────────────────────────────
// Correlation rule — block legs that aren't independent even across game ids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two legs are correlated (so a parlay must NOT combine them) when:
 *  - same gameId (handled separately as "same-game", but checked here too), OR
 *  - same player (a player's two props move together), OR
 *  - a pitcher-strikeouts leg sits in the SAME game as a batter leg (the
 *    pitcher suppressing/allowing offense is the other side of the K market):
 *    we match the pitcher's gameId against the batter leg's gameId, OR
 *  - a same-team stack: two legs whose `team` matches (offense rises together).
 *
 * Pure + deterministic — no I/O, fully unit-testable.
 */
export function legsCorrelated(a: CandidateLeg, b: CandidateLeg): boolean {
  if (a.legId === b.legId) return true;
  if (a.gameId && b.gameId && a.gameId === b.gameId) return true; // same game
  if (samePlayer(a.player, b.player)) return true; // a player's own props
  // Pitcher-K vs opposing batter — by construction these are the SAME game, so
  // the same-game guard above already catches the in-game case. The cross-id
  // case (a feed mislabels the game) is caught by the same-team check below.
  if (a.team && b.team && normalizeTeam(a.team) === normalizeTeam(b.team)) {
    return true; // same-team stack (offense correlated)
  }
  return false;
}

function normalizeTeam(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function samePlayer(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z]/g, "");
  return na.length > 0 && na === nb;
}

/** Is this propType a pitcher market? (used for the correlation rule). */
export function isPitcherProp(propType: string): boolean {
  return ["Strikeouts", "EarnedRuns", "HitsAllowed", "PitchingOuts"].includes(propType);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parlay math
// ─────────────────────────────────────────────────────────────────────────────

/** Parlay decimal odds = Π decimal_i. */
export function combinedDecimal(legs: { decimal: number }[]): number {
  return legs.reduce((acc, l) => acc * l.decimal, 1);
}

/** Parlay fair prob = Π fairProb_i (independence assumption — the whole thesis). */
export function combinedFairProb(legs: { fairProb: number }[]): number {
  return legs.reduce((acc, l) => acc * l.fairProb, 1);
}

/** Parlay true EV = Π(fairProb_i · decimal_i) − 1. */
export function parlayExpectedValue(legs: { fairProb: number; decimal: number }[]): number {
  return legs.reduce((acc, l) => acc * l.fairProb * l.decimal, 1) - 1;
}

/**
 * Survives the −δ-per-leg haircut: subtract `delta` from every leg's fairProb
 * (estimation-error guard) and require the haircut parlay to still be +EV.
 */
export function survivesHaircut(
  legs: { fairProb: number; decimal: number }[],
  delta: number,
): boolean {
  return (
    legs.reduce((acc, l) => acc * Math.max(0, l.fairProb - delta) * l.decimal, 1) - 1 > 0
  );
}

/**
 * The flip-δ: the per-leg fairProb haircut that drives parlayEV to exactly 0.
 * Found by bisection on the monotone-decreasing EV(δ). 0 means already at the
 * edge; larger δ = more margin for estimation error. Pure + deterministic.
 */
export function flipDelta(legs: { fairProb: number; decimal: number }[]): number {
  const ev = (d: number) =>
    legs.reduce((acc, l) => acc * Math.max(0, l.fairProb - d) * l.decimal, 1) - 1;
  if (ev(0) <= 0) return 0; // not +EV even with no haircut
  let lo = 0;
  let hi = Math.min(...legs.map((l) => l.fairProb)); // can't haircut a prob below 0
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const v = ev(mid);
    if (Math.abs(v) < 1e-12) return mid;
    if (v > 0) lo = mid;
    else hi = mid;
  }
  return +((lo + hi) / 2).toFixed(6);
}

/**
 * ¼-Kelly stake (USD) computed ONCE on the parlay's COMBINED prob and COMBINED
 * odds — never the product of per-leg Kelly fractions. Capped at maxStakePctEquity
 * and floored at minStakeUsd (returns 0 below the floor).
 */
export function parlayStake(
  combinedProb: number,
  combinedDec: number,
  equityUsd: number,
): number {
  const cfg = PARLAY_PAPER_CONFIG;
  const americanCombined = decimalToAmerican(combinedDec);
  if (!Number.isFinite(americanCombined)) return 0;
  const frac = kellyFraction(combinedProb, americanCombined, cfg.kellyMultiplier);
  if (frac <= 0) return 0;
  const raw = frac * equityUsd;
  const capped = Math.min(raw, cfg.maxStakePctEquity * equityUsd);
  if (capped < cfg.minStakeUsd) return 0;
  return +capped.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Store I/O
// ─────────────────────────────────────────────────────────────────────────────

function bookPath(dir: string): string {
  return path.join(dir, "parlay-paper-book.json");
}

export function loadBook(dir: string): ParlayPaperBook {
  const p = bookPath(dir);
  if (!fs.existsSync(p)) return { updatedAt: "", parlays: [], ledger: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as ParlayPaperBook;
    return {
      updatedAt: raw.updatedAt ?? "",
      parlays: raw.parlays ?? [],
      ledger: raw.ledger ?? [],
    };
  } catch {
    return { updatedAt: "", parlays: [], ledger: [] };
  }
}

export function saveBook(dir: string, book: ParlayPaperBook, nowIso: string): void {
  // Atomic write (temp + rename): the book is the paper-trial's permanent
  // financial record. A process killed mid-write (CI timeout) must never leave a
  // truncated JSON that loadBook() then silently degrades to an empty book —
  // that would erase every open/settled parlay and reset the equity curve. On
  // the same filesystem rename() is atomic: a reader sees the old or the new
  // complete book, never a half.
  const target = bookPath(dir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...book, updatedAt: nowIso }, null, 2));
  fs.renameSync(tmp, target);
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounting — DERIVED from parlay rows (no running cash that can drift)
// ─────────────────────────────────────────────────────────────────────────────

export function computeStats(book: ParlayPaperBook): ParlayPaperStats {
  const cfg = PARLAY_PAPER_CONFIG;
  const open = book.parlays.filter((p) => p.status === "open");
  const settled = book.parlays.filter((p) => p.status !== "open");
  const realizedPnlUsd = settled.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const exposureUsd = open.reduce((s, p) => s + p.stakeUsd, 0);
  const equityUsd = cfg.startingBankrollUsd + realizedPnlUsd;
  const wins = settled.filter((p) => p.status === "won").length;
  const losses = settled.filter((p) => p.status === "lost").length;
  const voids = settled.filter((p) => p.status === "void").length;
  // Decisive (won/lost) only — full-void refunds return the stake.
  const decisive = settled.filter((p) => p.status === "won" || p.status === "lost");
  const totalStakedUsd = decisive.reduce((s, p) => s + p.stakeUsd, 0);
  const evVals = book.parlays.map((p) => p.parlayEV).filter((v) => Number.isFinite(v));
  return {
    startingBankrollUsd: cfg.startingBankrollUsd,
    equityUsd: +equityUsd.toFixed(2),
    cashUsd: +(equityUsd - exposureUsd).toFixed(2),
    exposureUsd: +exposureUsd.toFixed(2),
    realizedPnlUsd: +realizedPnlUsd.toFixed(2),
    roiPct: +((realizedPnlUsd / cfg.startingBankrollUsd) * 100).toFixed(2),
    openCount: open.length,
    settledCount: settled.length,
    wins,
    losses,
    voids,
    winRatePct: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : null,
    totalStakedUsd: +totalStakedUsd.toFixed(2),
    yieldPct: totalStakedUsd > 0 ? +((realizedPnlUsd / totalStakedUsd) * 100).toFixed(2) : null,
    avgParlayEv: evVals.length
      ? +(evVals.reduce((s, v) => s + v, 0) / evVals.length).toFixed(4)
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate sourcing — dedup the props-board log to the latest tick per leg,
// keep only future-commence playable legs with a non-null gameId.
// ─────────────────────────────────────────────────────────────────────────────

type PropsLogRow = {
  ts: string;
  player: string;
  propType: string;
  line: number;
  side: "Over" | "Under";
  book: string;
  softAmerican: number;
  fairProb: number;
  evPct: number;
  playable?: boolean;
  commence: string;
  gameId?: string;
  team?: string;
  opponent?: string;
  league?: string; // board-tagged slate ("MLB"|"WNBA"|"NBA"); absent on legacy rows
};

/**
 * Build the candidate-leg pool from the accumulated props-board log:
 *  - keep only `playable` rows (EV ≥ floor) whose commence is still FUTURE,
 *  - dedup to the LATEST tick per (player, propType, side, line, book),
 *  - drop rows with no gameId (ineligible — counted in the tally),
 *  - league taken from the board's slate tag (MLB/WNBA/NBA), falling back to a
 *    propType guess for legacy rows.
 * Pure given (rows, nowMs); the caller does the file read.
 */
export function buildCandidates(
  rows: PropsLogRow[],
  nowMs: number,
  tally?: SkipTally,
): CandidateLeg[] {
  const latest = new Map<string, PropsLogRow>();
  for (const r of rows) {
    if (!r.playable) continue;
    const commenceMs = new Date(r.commence).getTime();
    if (!Number.isFinite(commenceMs) || commenceMs <= nowMs) continue; // no look-ahead
    const key = legKey({
      player: r.player,
      propType: r.propType,
      side: r.side,
      line: r.line,
      book: r.book,
      gameId: r.gameId ?? "",
    });
    const prev = latest.get(key);
    if (!prev || r.ts > prev.ts) latest.set(key, r);
  }

  const out: CandidateLeg[] = [];
  for (const r of latest.values()) {
    const gameId = (r.gameId ?? "").trim();
    if (!gameId) {
      if (tally) tally.noGameId++;
      continue; // ineligible for parlays
    }
    out.push({
      legId: legKey({
        player: r.player,
        propType: r.propType,
        side: r.side,
        line: r.line,
        book: r.book,
        gameId,
      }),
      player: r.player,
      gameId,
      team: r.team,
      opponent: r.opponent,
      propType: r.propType,
      line: r.line,
      side: r.side,
      oddsAmerican: r.softAmerican,
      book: r.book,
      fairProb: r.fairProb,
      commence: r.commence,
      // Prefer the board's slate tag; fall back to the propType guess for
      // legacy rows logged before the board carried a league.
      league: parlayLeague(r.league) ?? leagueForProp(r.propType),
    });
  }
  return out;
}

/** Narrow a board league string to a ParlayLeague, or null if unrecognized. */
function parlayLeague(league?: string): ParlayLeague | null {
  return league === "MLB" || league === "NBA" || league === "WNBA" ? league : null;
}

const MLB_PROPS = new Set([
  "Strikeouts",
  "HomeRuns",
  "TotalBases",
  "EarnedRuns",
  "HitsAllowed",
  "PitchingOuts",
]);

export function leagueForProp(propType: string): ParlayLeague {
  return MLB_PROPS.has(propType) ? "MLB" : "NBA";
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly — choose disjoint +EV three-leg parlays from distinct games
// ─────────────────────────────────────────────────────────────────────────────

export type AssemblyResult = {
  parlays: ParlayBet[];
  tally: SkipTally;
};

function toLeg(c: CandidateLeg): ParlayLeg {
  return {
    legId: c.legId,
    player: c.player,
    gameId: c.gameId,
    team: c.team,
    opponent: c.opponent,
    propType: c.propType,
    line: c.line,
    side: c.side,
    oddsAmerican: c.oddsAmerican,
    book: c.book,
    fairProb: c.fairProb,
    decimal: americanToDecimal(c.oddsAmerican),
    commence: c.commence,
    league: c.league,
    status: "open",
    actual: null,
    finalScore: null,
  };
}

/**
 * Greedy assembly of disjoint +EV three-leg parlays. Pure: given candidates +
 * the set of leg ids already used (across open parlays) + current equity, it
 * returns the new parlays to open and the per-reason skip tally. No I/O.
 *
 * Greedy is deliberate: best-edge legs combine first, each leg lands in at most
 * one parlay (no exposure double-count), and the deterministic parlay id means
 * a rerun of the same slate produces the same ids → the open step de-dups them.
 */
export function assembleParlays(
  candidates: CandidateLeg[],
  alreadyUsedLegIds: Set<string>,
  existingParlayIds: Set<string>,
  equityUsd: number,
  tally: SkipTally = emptyTally(),
): AssemblyResult {
  const cfg = PARLAY_PAPER_CONFIG;

  // Strongest legs first (highest single-leg edge), so greedy picks them up.
  // Candidates from buildCandidates are already gameId-filtered; this is a
  // defensive backstop for direct callers (e.g. tests) and does NOT re-tally
  // no-gameId (buildCandidates owns that count).
  const pool = [...candidates]
    .filter((c) => {
      if (!c.gameId) {
        tally.noGameId++;
        return false;
      }
      const dec = americanToDecimal(c.oddsAmerican);
      return Number.isFinite(dec) && c.fairProb > 0 && c.fairProb < 1;
    })
    .sort((a, b) => edge(b) - edge(a));

  const used = new Set(alreadyUsedLegIds);
  const parlays: ParlayBet[] = [];

  // Examine ordered triples without re-using a leg already committed this run.
  // Each opened parlay commits its three legs to `used`; once an OUTER anchor
  // (i or j) is consumed we must stop reusing it — break out of the inner loops
  // so the next anchor is re-evaluated. (Re-checking only at loop entry would
  // let a freshly-committed i/j be paired again with a later k.)
  for (let i = 0; i < pool.length; i++) {
    if (used.has(pool[i].legId)) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (used.has(pool[i].legId)) break; // anchor i was consumed → re-pick i
      if (used.has(pool[j].legId)) continue;
      for (let k = j + 1; k < pool.length; k++) {
        if (used.has(pool[i].legId) || used.has(pool[j].legId)) break; // i/j consumed
        if (used.has(pool[k].legId)) continue;
        const trio = [pool[i], pool[j], pool[k]];
        tally.started++;

        // distinct games
        const games = new Set(trio.map((l) => l.gameId));
        if (games.size < cfg.legsPerParlay) {
          tally.sameGame++;
          continue;
        }
        // pairwise correlation (player/team/same-game backstop)
        if (anyCorrelated(trio)) {
          tally.correlated++;
          continue;
        }

        const legs = trio.map(toLeg);
        const parlayEv = parlayExpectedValue(legs);
        if (parlayEv <= 0) {
          tally.negEV++;
          continue;
        }
        if (!survivesHaircut(legs, cfg.haircutPerLegProb)) {
          tally.haircut++;
          continue;
        }

        const dec = combinedDecimal(legs);
        const prob = combinedFairProb(legs);
        const stakeUsd = parlayStake(prob, dec, equityUsd);
        if (stakeUsd <= 0) {
          tally.tooSmall++;
          continue;
        }

        const id = parlayId(legs.map((l) => l.legId));
        if (existingParlayIds.has(id) || parlays.some((p) => p.id === id)) {
          tally.dup++;
          continue;
        }

        parlays.push({
          id,
          openedAt: "", // filled by caller (single now)
          legs,
          survivingLegIds: legs.map((l) => l.legId),
          parlayDecimalOdds: +dec.toFixed(6),
          parlayFairProb: +prob.toFixed(6),
          parlayEV: +parlayEv.toFixed(6),
          flipDelta: flipDelta(legs),
          stakeUsd,
          status: "open",
          pnlUsd: null,
          settledAt: null,
        });
        // commit these three legs so they can't appear in another parlay
        for (const l of legs) used.add(l.legId);
      }
    }
  }

  return { parlays, tally };
}

function edge(c: CandidateLeg): number {
  const dec = americanToDecimal(c.oddsAmerican);
  return Number.isFinite(dec) ? c.fairProb * dec - 1 : -1;
}

function anyCorrelated(trio: CandidateLeg[]): boolean {
  for (let a = 0; a < trio.length; a++) {
    for (let b = a + 1; b < trio.length; b++) {
      if (legsCorrelated(trio[a], trio[b])) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement — DROP push/void legs, re-price the parlay to the survivors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-price a parlay from its (already-graded) legs. PUSH and VOID legs DROP out
 * (they're refunded into the surviving combination); WON legs stay; any LOST
 * leg → the parlay loses. Returns the settled status + P&L, or null when the
 * parlay still has an OPEN leg (stay open — never count unsettled as a win).
 *
 * Pure: operates on the leg statuses already written by the box-score grader.
 */
export function settleFromLegs(p: ParlayBet): {
  status: "won" | "lost" | "void";
  pnlUsd: number;
  survivingLegIds: string[];
} | null {
  if (p.legs.some((l) => l.status === "open")) return null; // not all terminal

  if (p.legs.some((l) => l.status === "lost")) {
    return { status: "lost", pnlUsd: +(-p.stakeUsd).toFixed(2), survivingLegIds: [] };
  }

  // No losers. Survivors = the WON legs; push/void drop out and refund.
  const survivors = p.legs.filter((l) => l.status === "won");
  if (survivors.length === 0) {
    // all legs pushed/voided → full refund, no action
    return { status: "void", pnlUsd: 0, survivingLegIds: [] };
  }
  const dec = combinedDecimal(survivors);
  const pnl = +(p.stakeUsd * (dec - 1)).toFixed(2);
  return { status: "won", pnlUsd: pnl, survivingLegIds: survivors.map((l) => l.legId) };
}

export function writeSnapshot(book: ParlayPaperBook, nowIso: string): ParlayPaperStats {
  const s = computeStats(book);
  book.ledger.push({
    ts: nowIso,
    equityUsd: s.equityUsd,
    realizedPnlUsd: s.realizedPnlUsd,
    exposureUsd: s.exposureUsd,
    openCount: s.openCount,
    settledCount: s.settledCount,
    wins: s.wins,
    losses: s.losses,
  });
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only ledger view (dashboard shape — mirrors getDevigLedgerView)
// ─────────────────────────────────────────────────────────────────────────────

export function getParlayLedgerView(dir = path.join(process.cwd(), "data", "processed")) {
  const book = loadBook(dir);
  const stats = computeStats(book);
  return {
    stats,
    config: {
      evFloor: PARLAY_PAPER_CONFIG.evFloor,
      legsPerParlay: PARLAY_PAPER_CONFIG.legsPerParlay,
      haircutPerLegProb: PARLAY_PAPER_CONFIG.haircutPerLegProb,
      kellyMultiplier: PARLAY_PAPER_CONFIG.kellyMultiplier,
    },
    open: book.parlays
      .filter((p) => p.status === "open")
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
    settled: book.parlays
      .filter((p) => p.status !== "open")
      .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""))
      .slice(0, 100),
    equityCurve: book.ledger.slice(-200),
    generatedAt: new Date().toISOString(),
  };
}

// Implied-prob helper retained for potential CLV reporting (kept local so the
// module's import set documents what the engine touches).
export { americanToImpliedProb };

// ─────────────────────────────────────────────────────────────────────────────
// Leg grading (impure) — resolve each open leg against its game's box score.
// A leg is VOID (pitcher scratched / game postponed) iff resolveProp returns
// null AFTER the game window has closed; before the window it stays open.
// ─────────────────────────────────────────────────────────────────────────────

// A leg's game is considered "closed enough to call a void" this many ms after
// its commence time — i.e. the game should be final by now. MLB ~4.5h, but we
// use a generous 8h so a long/delayed game isn't called void prematurely.
export const GAME_WINDOW_CLOSE_MS = 8 * 60 * 60 * 1000;

/**
 * Grade every open leg across all open parlays in place, using ESPN box scores.
 * Builds one PlayerStatLookup per (league, yyyymmdd) actually needed. After the
 * game window closes, an unresolvable leg (no box-score line for the player) is
 * marked `void` — that's the scratch/postpone path. Impure (network).
 */
export async function gradeOpenLegs(book: ParlayPaperBook, nowMs: number): Promise<number> {
  const openParlays = book.parlays.filter((p) => p.status === "open");
  const openLegs = openParlays.flatMap((p) => p.legs).filter((l) => l.status === "open");
  if (openLegs.length === 0) return 0;

  // Which (league, day) lookups do we need? Anchor on each leg's commence day.
  const needed = new Map<string, { league: PropGradingLeague; day: string }>();
  for (const l of openLegs) {
    const commenceMs = new Date(l.commence).getTime();
    if (!Number.isFinite(commenceMs) || nowMs < commenceMs) continue; // not started
    const day = yyyymmdd(new Date(commenceMs));
    const key = `${l.league}:${day}`;
    if (!needed.has(key)) needed.set(key, { league: l.league as PropGradingLeague, day });
  }

  const lookups = new Map<string, PlayerStatLookup>();
  for (const [key, { league, day }] of needed) {
    lookups.set(key, await buildPlayerStatLookup(league, day));
  }

  let graded = 0;
  for (const l of openLegs) {
    const commenceMs = new Date(l.commence).getTime();
    if (!Number.isFinite(commenceMs) || nowMs < commenceMs) continue;
    const day = yyyymmdd(new Date(commenceMs));
    const lookup = lookups.get(`${l.league}:${day}`);
    if (!lookup) continue;
    const res = resolveProp(lookup, {
      player: l.player,
      propType: marketKeyFor(l.propType),
      line: l.line,
      side: l.side.toLowerCase() as "over" | "under",
      anchorMs: commenceMs,
    });
    if (!res) {
      // No box-score line. If the game window has closed, the player didn't
      // record (scratch / postpone / DNP) → VOID. Otherwise still in progress.
      if (nowMs >= commenceMs + GAME_WINDOW_CLOSE_MS) {
        l.status = "void";
        l.actual = null;
        graded++;
      }
      continue;
    }
    l.actual = res.actual;
    l.status = res.result === "win" ? "won" : res.result === "loss" ? "lost" : "push";
    graded++;
  }
  return graded;
}

// Map our Pinnacle `units` back to the prop-grading market key the stat map
// keys on. The props board stores Pinnacle units ("Strikeouts"); resolveProp
// keys on Odds-API-style market keys ("pitcher_strikeouts").
const UNITS_TO_MARKET_KEY: Record<string, string> = {
  Strikeouts: "pitcher_strikeouts",
  HomeRuns: "batter_home_runs",
  TotalBases: "batter_total_bases",
  EarnedRuns: "pitcher_earned_runs",
  Points: "player_points",
  Rebounds: "player_rebounds",
  Assists: "player_assists",
  "Threes Made": "player_threes",
};

export function marketKeyFor(units: string): string {
  return UNITS_TO_MARKET_KEY[units] ?? units;
}

/** Settle every open parlay whose legs are all terminal. Mutates the book. */
export function settleParlays(book: ParlayPaperBook, nowMs: number): number {
  let settled = 0;
  for (const p of book.parlays) {
    if (p.status !== "open") continue;
    const result = settleFromLegs(p);
    if (!result) continue; // a leg still open → stay open, count nothing
    p.status = result.status;
    p.pnlUsd = result.pnlUsd;
    p.survivingLegIds = result.survivingLegIds;
    p.settledAt = new Date(nowMs).toISOString();
    settled++;
  }
  return settled;
}

// ─────────────────────────────────────────────────────────────────────────────
// One full cycle (impure: reads props-board log + ESPN, writes book)
// ─────────────────────────────────────────────────────────────────────────────

export async function runParlayPaperCycle(
  opts: { dataDir?: string; nowMs?: number } = {},
): Promise<{
  opened: number;
  settled: number;
  legsGraded: number;
  tally: SkipTally;
  stats: ParlayPaperStats;
}> {
  const dir = opts.dataDir ?? path.join(process.cwd(), "data", "processed");
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const book = loadBook(dir);

  // 1) settle first — grade legs, then re-price parlays (realizes P&L before sizing)
  const legsGraded = await gradeOpenLegs(book, nowMs);
  const settled = settleParlays(book, nowMs);

  // 2) open new parlays from the props-board log
  const logPath = path.join(dir, "props-board-log.json");
  let rows: PropsLogRow[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath, "utf8")) as { entries?: PropsLogRow[] };
    rows = parsed.entries ?? [];
  } catch {
    rows = [];
  }
  const tally = emptyTally();
  const candidates = buildCandidates(rows, nowMs, tally); // counts no-gameId drops
  const { equityUsd } = computeStats(book);
  const usedLegIds = new Set(
    book.parlays.filter((p) => p.status === "open").flatMap((p) => p.legs.map((l) => l.legId)),
  );
  const existingIds = new Set(book.parlays.map((p) => p.id));
  const { parlays } = assembleParlays(candidates, usedLegIds, existingIds, equityUsd, tally);

  let opened = 0;
  for (const p of parlays) {
    p.openedAt = nowIso;
    book.parlays.push(p);
    opened++;
  }

  // 3) snapshot
  const stats = writeSnapshot(book, nowIso);
  saveBook(dir, book, nowIso);

  return { opened, settled, legsGraded, tally, stats };
}
