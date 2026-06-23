// nfl-parlay.ts — Experiment No. 5 parlay BACKTEST engine (pure, leak-free).
//
// Post-hoc analog of the MLB parlay engine (parlay-paper.ts) for the PRIVATE NFL
// backtest learning loop. It reads the loop's ALREADY-GRADED game picks
// (GradedRow) and prop picks (GradedPropRow) and forms 3-leg parlays under the
// studio's DURABLE PARLAY DOCTRINE (memory.ts → PARLAY_LEARNINGS), grades them
// against the already-known per-leg results, and produces a private parlay book.
//
// This is a RETROSPECTIVE, like scripts/parlay-backtest.ts — it opens no live
// paper bet and is QUARANTINED from any live pick loop. It mirrors parlay-paper's
// math (combined fair prob = Π modelProb, −δ-per-leg haircut, ¼-Kelly on the
// COMBINED prob/odds capped at maxStakePctEquity) and its ledger/stats shape so
// the dashboard can render NFL parlays the same way as MLB.
//
// ── THE NO-LEAKAGE GUARANTEE ───────────────────────────────────────────────────
// The legs are already-graded historical rows, BUT the SELECTION of which legs to
// combine uses ONLY pre-game fields: edge (modelProb − impliedProb), oddsAmerican,
// favored, confidence. The grader (`result`) is read ONLY in gradeParlay /
// settlement — NEVER in eligibility, ranking, or assembly. Selecting on `result`
// would be look-ahead and is forbidden. The no-leakage test asserts this.

import {
  americanToDecimal,
  americanToImpliedProb,
  decimalToAmerican,
  kellyFraction,
} from "./devig";
import type { GradedRow, GradedPropRow, GameType, PickResult } from "./nfl-loop";

// ─────────────────────────────────────────────────────────────────────────────
// Config — mirrors PARLAY_PAPER_CONFIG (the durable doctrine encoded as numbers)
// ─────────────────────────────────────────────────────────────────────────────

export const NFL_PARLAY_CONFIG = {
  startingBankrollUsd: 10_000,
  edgeFloor: 0.03, // a leg qualifies only if modelProb − impliedProb ≥ 3%
  legsPerParlay: 3, // exactly three legs, three DISTINCT games
  haircutPerLegProb: 0.04, // −4pt per-leg modelProb haircut the parlay must survive
  longshotMaxAmerican: 150, // exclude legs priced longer than +150 (favorites, not longshots)
  kellyMultiplier: 0.25, // ¼-Kelly on the COMBINED prob/odds (never per-leg product)
  maxStakePctEquity: 0.05, // cap any one parlay at 5% of equity (same as MLB)
  minStakeUsd: 10, // floor — below this isn't worth booking
  maxParlaysPerWeek: 5, // cap parlays formed per slate-week (overfitting guard)
  propDefaultAmerican: -110, // props grade at -110 unless the row carries odds
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Candidate leg — the unified pre-game view of a graded game/prop row
// ─────────────────────────────────────────────────────────────────────────────

export type LegKind = "game" | "prop";

/** A single qualifying leg, locked from a graded row. `result` is carried for
 *  GRADING ONLY — assembly + ranking must never read it (see no-leakage gate). */
export type NflParlayLeg = {
  legId: string; // stable per source-row key
  kind: LegKind;
  gameId: string; // correlation key — legs must come from DISTINCT gameIds
  season: number;
  phase: GameType;
  week: number;
  selection: string; // human-readable ("KC ML", "P.Mahomes passYds Over 250")
  oddsAmerican: number;
  decimal: number; // americanToDecimal(oddsAmerican), cached for audit
  modelProb: number; // the model's prob for this leg (= confidence, clamped)
  impliedProb: number; // vig-inclusive implied prob from oddsAmerican
  edge: number; // modelProb − impliedProb (the pre-game ranking key)
  // settlement — read ONLY by gradeParlay, NEVER by eligibility/assembly:
  result: PickResult | "no-data";
};

// ─────────────────────────────────────────────────────────────────────────────
// Skip-reason tally — every reason a leg or candidate triple is rejected
// ─────────────────────────────────────────────────────────────────────────────

export type NflParlaySkipTally = {
  legsSeen: number; // graded rows examined
  noData: number; // prop rows with no-data result (never eligible)
  belowEdgeFloor: number; // legs failing the +EV floor
  longshot: number; // legs priced longer than +150
  badOdds: number; // non-finite / unusable odds
  eligibleLegs: number; // legs that survived all gates
  triplesStarted: number; // candidate triples examined during assembly
  sameGame: number; // triples sharing a gameId (correlation tax)
  haircut: number; // triples that didn't survive the −4pt haircut
  tooSmall: number; // triples whose ¼-Kelly stake fell below the floor
  cappedDropped: number; // eligible legs left unused because the per-week cap BOUND
  legsStranded: number; // eligible legs left unused when the cap did NOT bind
  // (no valid 3-leg parlay could be formed from them — e.g. all same-game, or
  //  fewer than 3 distinct games). Lets the funnel reconcile:
  //   eligibleLegs == (legs used in parlays) + cappedDropped + legsStranded
  // so an operator can tell "doctrine rejected everything" from "assembler bug".
};

export function emptyTally(): NflParlaySkipTally {
  return {
    legsSeen: 0,
    noData: 0,
    belowEdgeFloor: 0,
    longshot: 0,
    badOdds: 0,
    eligibleLegs: 0,
    triplesStarted: 0,
    sameGame: 0,
    haircut: 0,
    tooSmall: 0,
    cappedDropped: 0,
    legsStranded: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The parlay row + book + stats shapes — mirror parlay-paper.ts
// ─────────────────────────────────────────────────────────────────────────────

export type NflParlayBet = {
  id: string; // deterministic = sorted leg ids — re-running a week opens no dup
  season: number;
  phase: GameType;
  week: number;
  legs: NflParlayLeg[];
  parlayDecimalOdds: number; // Π decimal_i
  parlayFairProb: number; // Π modelProb_i
  parlayEV: number; // Π(modelProb_i·decimal_i) − 1
  stakeUsd: number; // ¼-Kelly on combined prob/odds, capped + floored
  // settlement (graded from the legs' already-known results):
  status: "won" | "lost" | "void";
  pnlUsd: number;
};

export type NflParlayBook = {
  generatedAt: string;
  startingBankrollUsd: number;
  parlays: NflParlayBet[];
  tally: NflParlaySkipTally;
};

export type NflParlayStats = {
  startingBankrollUsd: number;
  equityUsd: number;
  realizedPnlUsd: number;
  roiPct: number; // realizedPnl / startingBankroll
  settledCount: number;
  wins: number;
  losses: number;
  voids: number;
  winRatePct: number | null;
  totalStakedUsd: number;
  yieldPct: number | null; // realizedPnl / totalStaked (decisive only)
  avgLegsEdge: number | null; // mean per-leg edge across all decisive parlay legs
};

// ─────────────────────────────────────────────────────────────────────────────
// Leg construction — game + prop rows → unified candidate legs
// ─────────────────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Build a candidate leg from a graded GAME row. Returns null when the odds are
 *  unusable. `result` is copied for grading only. */
function gameRowToLeg(r: GradedRow): NflParlayLeg | null {
  const dec = americanToDecimal(r.oddsAmerican);
  if (!Number.isFinite(dec) || dec <= 1) return null;
  return {
    legId: `game|${r.key}`,
    kind: "game",
    gameId: r.gameId,
    season: r.season,
    phase: r.phase,
    week: r.week,
    selection: `${r.matchup} · ${r.selection}`,
    oddsAmerican: r.oddsAmerican,
    decimal: dec,
    modelProb: clamp01(r.confidence),
    impliedProb: americanToImpliedProb(r.oddsAmerican),
    edge: clamp01(r.confidence) - americanToImpliedProb(r.oddsAmerican),
    result: r.result,
  };
}

/** Build a candidate leg from a graded PROP row. Props grade at -110 unless the
 *  row carries an odds field; GradedPropRow has none, so -110 is used. */
function propRowToLeg(r: GradedPropRow): NflParlayLeg | null {
  // A prop row may carry odds on a future schema; tolerate it, else default -110.
  // GradedPropRow has no odds field today, so this reads through `unknown`.
  const maybeOdds = (r as unknown as { oddsAmerican?: unknown }).oddsAmerican;
  const odds =
    typeof maybeOdds === "number" && Number.isFinite(maybeOdds)
      ? maybeOdds
      : NFL_PARLAY_CONFIG.propDefaultAmerican;
  const dec = americanToDecimal(odds);
  if (!Number.isFinite(dec) || dec <= 1) return null;
  return {
    legId: `prop|${r.key}`,
    kind: "prop",
    gameId: r.gameId,
    season: r.season,
    phase: r.phase,
    week: r.week,
    selection: `${r.player} ${r.stat} ${r.side} ${r.threshold}`,
    oddsAmerican: odds,
    decimal: dec,
    modelProb: clamp01(r.confidence),
    impliedProb: americanToImpliedProb(odds),
    edge: clamp01(r.confidence) - americanToImpliedProb(odds),
    result: r.result,
  };
}

/**
 * Reduce graded game + prop rows to the ELIGIBLE candidate-leg pool, applying the
 * per-leg doctrine gates (NOT the parlay-level haircut — that's per-triple):
 *   1. drop prop rows with `no-data` (never form a parlay on an ungraded leg),
 *   2. +EV floor: edge = modelProb − impliedProb ≥ edgeFloor (3%),
 *   3. longshot exclusion: oddsAmerican ≤ +150 (favorites, not longshots).
 *
 * LEAK-FREE: every gate here reads ONLY pre-game fields (confidence-derived
 * modelProb, oddsAmerican-derived impliedProb/edge). `result` is NOT read for
 * eligibility — the `no-data` drop is the lone exception and it is structural
 * (an ungraded leg has no leg to settle), never a win/loss-based selection.
 */
export function toEligibleLegs(
  games: GradedRow[],
  props: GradedPropRow[],
  tally: NflParlaySkipTally = emptyTally(),
): NflParlayLeg[] {
  const cfg = NFL_PARLAY_CONFIG;
  const out: NflParlayLeg[] = [];

  const consider = (leg: NflParlayLeg | null, isNoData: boolean): void => {
    tally.legsSeen++;
    if (isNoData) {
      tally.noData++;
      return; // ungraded → never eligible (structural, not result-based)
    }
    if (!leg) {
      tally.badOdds++;
      return;
    }
    if (leg.oddsAmerican > cfg.longshotMaxAmerican) {
      tally.longshot++;
      return;
    }
    if (leg.edge < cfg.edgeFloor) {
      tally.belowEdgeFloor++;
      return;
    }
    tally.eligibleLegs++;
    out.push(leg);
  };

  for (const r of games) consider(gameRowToLeg(r), false);
  for (const r of props) {
    if (r.result === "no-data") {
      consider(null, true);
      continue;
    }
    consider(propRowToLeg(r), false);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parlay math — identical formulas to parlay-paper.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Parlay decimal odds = Π decimal_i. */
export function combinedDecimal(legs: { decimal: number }[]): number {
  return legs.reduce((acc, l) => acc * l.decimal, 1);
}

/** Parlay fair prob = Π modelProb_i (independence assumption — the thesis). */
export function combinedFairProb(legs: { modelProb: number }[]): number {
  return legs.reduce((acc, l) => acc * l.modelProb, 1);
}

/** Parlay true EV = Π(modelProb_i · decimal_i) − 1. */
export function parlayExpectedValue(legs: { modelProb: number; decimal: number }[]): number {
  return legs.reduce((acc, l) => acc * l.modelProb * l.decimal, 1) - 1;
}

/**
 * Survives the −δ-per-leg haircut: shave `delta` off EVERY leg's modelProb
 * (estimation error CUBES in a 3-leg parlay) and require the haircut parlay to be
 * strictly +EV vs the combined price. This is doctrine gate #4.
 */
export function survivesHaircut(
  legs: { modelProb: number; decimal: number }[],
  delta: number,
): boolean {
  return (
    legs.reduce((acc, l) => acc * Math.max(0, l.modelProb - delta) * l.decimal, 1) - 1 > 0
  );
}

/**
 * ¼-Kelly stake (USD) computed ONCE on the parlay's COMBINED prob and COMBINED
 * odds — never the product of per-leg Kelly. Capped at maxStakePctEquity and
 * floored at minStakeUsd (returns 0 below the floor). Mirrors parlayStake().
 */
export function parlayStake(
  combinedProb: number,
  combinedDec: number,
  equityUsd: number,
): number {
  const cfg = NFL_PARLAY_CONFIG;
  const americanCombined = decimalToAmerican(combinedDec);
  if (!Number.isFinite(americanCombined)) return 0;
  const frac = kellyFraction(combinedProb, americanCombined, cfg.kellyMultiplier);
  if (frac <= 0) return 0;
  const raw = frac * equityUsd;
  const capped = Math.min(raw, cfg.maxStakePctEquity * equityUsd);
  if (capped < cfg.minStakeUsd) return 0;
  return +capped.toFixed(2);
}

/** Deterministic parlay id = sorted leg ids. Re-running a week can't dup. */
export function parlayId(legIds: string[]): string {
  return [...legIds].sort().join("~");
}

// ─────────────────────────────────────────────────────────────────────────────
// Grading — a parlay wins ONLY if all 3 legs won. Push/void DROP out and the
// parlay re-prices to the survivors (matches parlay-paper.ts settleFromLegs).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grade a fully-built parlay from its legs' ALREADY-KNOWN results.
 *   - any leg lost  → parlay LOST (−stake),
 *   - else survivors = the WON legs; push drops out & refunds into the combo,
 *   - all-push (no winners) → VOID (full refund, P&L 0).
 *
 * This is the ONLY place `result` is consulted. Pure.
 */
export function gradeParlay(
  legs: NflParlayLeg[],
  stakeUsd: number,
): { status: "won" | "lost" | "void"; pnlUsd: number } {
  if (legs.some((l) => l.result === "loss")) {
    return { status: "lost", pnlUsd: +(-stakeUsd).toFixed(2) };
  }
  const winners = legs.filter((l) => l.result === "win");
  if (winners.length === 0) {
    // every surviving leg pushed (or was a no-data that slipped through — but the
    // eligibility gate already excludes no-data, so this is the all-push case)
    return { status: "void", pnlUsd: 0 };
  }
  const dec = combinedDecimal(winners);
  return { status: "won", pnlUsd: +(stakeUsd * (dec - 1)).toFixed(2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly — greedy disjoint 3-leg parlays within ONE slate-week
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Form parlays from one week's eligible legs (caller groups by season/phase/week).
 *
 * Construction policy (deterministic, pre-registered — ZERO look-ahead):
 *   - rank eligible legs by EDGE desc (pre-game field), ties broken by legId,
 *   - greedily walk distinct-game triples; each leg is used at most once,
 *   - a triple OPENS only if it clears: distinct gameIds, the −4pt haircut, and a
 *     ¼-Kelly stake ≥ minStakeUsd,
 *   - cap parlays-per-week at maxParlaysPerWeek; eligible legs left unused after
 *     the cap are counted in tally.cappedDropped (NO silent truncation).
 *
 * Pure: takes the week's legs + equity, returns the parlays + mutates the tally.
 * `result` is NEVER read here — only edge/odds/modelProb. gradeParlay settles.
 */
export function assembleWeekParlays(
  weekLegs: NflParlayLeg[],
  equityUsd: number,
  tally: NflParlaySkipTally = emptyTally(),
): NflParlayBet[] {
  const cfg = NFL_PARLAY_CONFIG;

  // Rank by pre-game edge desc; stable tiebreak on legId. (No result read.)
  const pool = [...weekLegs].sort((a, b) => {
    if (b.edge !== a.edge) return b.edge - a.edge;
    return a.legId.localeCompare(b.legId);
  });

  const used = new Set<string>();
  const parlays: NflParlayBet[] = [];
  const seenIds = new Set<string>();

  outer: for (let i = 0; i < pool.length; i++) {
    if (used.has(pool[i].legId)) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (used.has(pool[i].legId)) break; // anchor i consumed → re-pick i
      if (used.has(pool[j].legId)) continue;
      for (let k = j + 1; k < pool.length; k++) {
        if (used.has(pool[i].legId) || used.has(pool[j].legId)) break;
        if (used.has(pool[k].legId)) continue;
        const trio = [pool[i], pool[j], pool[k]];
        tally.triplesStarted++;

        // distinct games (a game leg + a prop leg from the same gameId are also
        // correlated — the Set on gameId catches BOTH cases)
        if (new Set(trio.map((l) => l.gameId)).size < cfg.legsPerParlay) {
          tally.sameGame++;
          continue;
        }

        // −4pt-per-leg haircut survival (doctrine gate #4)
        if (!survivesHaircut(trio, cfg.haircutPerLegProb)) {
          tally.haircut++;
          continue;
        }

        const dec = combinedDecimal(trio);
        const prob = combinedFairProb(trio);
        const stakeUsd = parlayStake(prob, dec, equityUsd);
        if (stakeUsd <= 0) {
          tally.tooSmall++;
          continue;
        }

        const id = parlayId(trio.map((l) => l.legId));
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const ev = parlayExpectedValue(trio);
        const { status, pnlUsd } = gradeParlay(trio, stakeUsd);
        parlays.push({
          id,
          season: trio[0].season,
          phase: trio[0].phase,
          week: trio[0].week,
          legs: trio,
          parlayDecimalOdds: +dec.toFixed(6),
          parlayFairProb: +prob.toFixed(6),
          parlayEV: +ev.toFixed(6),
          stakeUsd,
          status,
          pnlUsd,
        });
        for (const l of trio) used.add(l.legId);

        if (parlays.length >= cfg.maxParlaysPerWeek) break outer;
      }
    }
  }

  // Reconcile every eligible leg that didn't end up in a parlay (no silent
  // truncation): if the per-week cap BOUND, the leftovers are cappedDropped;
  // otherwise the assembler simply couldn't form a valid parlay from them
  // (all same-game, < 3 distinct games, none survived the haircut, …) → those
  // are legsStranded. Either way eligibleLegs now fully reconciles:
  //   eligibleLegs == (legs used) + cappedDropped + legsStranded
  const unused = pool.filter((l) => !used.has(l.legId)).length;
  if (parlays.length >= cfg.maxParlaysPerWeek) {
    tally.cappedDropped += unused;
  } else {
    tally.legsStranded += unused;
  }

  return parlays;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full backtest — group by slate-week, assemble, grade, accumulate
// ─────────────────────────────────────────────────────────────────────────────

function weekKey(season: number, phase: GameType, week: number): string {
  return `${season}|${phase}|${String(week).padStart(2, "0")}`;
}

/**
 * Run the full backtest over all graded rows. Groups eligible legs by slate-week,
 * assembles + grades each week's parlays against a RUNNING equity (so ¼-Kelly
 * sizes off the bankroll as it moves, like the live book), and returns the book.
 *
 * Weeks are processed in chronological order (season, phase REG<POST, week) so
 * the running equity is causal. Pure given (games, props, nowIso).
 */
export function runNflParlayBacktest(
  games: GradedRow[],
  props: GradedPropRow[],
  nowIso: string,
): NflParlayBook {
  const cfg = NFL_PARLAY_CONFIG;
  const tally = emptyTally();
  const eligible = toEligibleLegs(games, props, tally);

  // Group by slate-week.
  const byWeek = new Map<string, NflParlayLeg[]>();
  for (const leg of eligible) {
    const k = weekKey(leg.season, leg.phase, leg.week);
    const list = byWeek.get(k);
    if (list) list.push(leg);
    else byWeek.set(k, [leg]);
  }

  // Chronological week order: season asc, REG before POST, week asc.
  const phaseRank = (p: GameType) => (p === "REG" ? 0 : 1);
  const orderedKeys = [...byWeek.keys()].sort((a, b) => {
    const [sa, pa, wa] = a.split("|");
    const [sb, pb, wb] = b.split("|");
    if (sa !== sb) return Number(sa) - Number(sb);
    const pra = phaseRank(pa as GameType);
    const prb = phaseRank(pb as GameType);
    if (pra !== prb) return pra - prb;
    return Number(wa) - Number(wb);
  });

  let equityUsd: number = cfg.startingBankrollUsd;
  const parlays: NflParlayBet[] = [];
  for (const k of orderedKeys) {
    const weekParlays = assembleWeekParlays(byWeek.get(k)!, equityUsd, tally);
    for (const p of weekParlays) {
      parlays.push(p);
      equityUsd = +(equityUsd + p.pnlUsd).toFixed(2); // realize before sizing next
    }
  }

  return {
    generatedAt: nowIso,
    startingBankrollUsd: cfg.startingBankrollUsd,
    parlays,
    tally,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats — DERIVED from the parlay rows (no running cash that can drift)
// ─────────────────────────────────────────────────────────────────────────────

export function computeNflParlayStats(book: NflParlayBook): NflParlayStats {
  const start = book.startingBankrollUsd;
  const parlays = book.parlays;
  const realizedPnlUsd = parlays.reduce((s, p) => s + p.pnlUsd, 0);
  const wins = parlays.filter((p) => p.status === "won").length;
  const losses = parlays.filter((p) => p.status === "lost").length;
  const voids = parlays.filter((p) => p.status === "void").length;
  const decisive = parlays.filter((p) => p.status === "won" || p.status === "lost");
  const totalStakedUsd = decisive.reduce((s, p) => s + p.stakeUsd, 0);

  // avgLegsEdge = mean per-leg pre-game edge across every decisive parlay's legs.
  const legEdges: number[] = [];
  for (const p of decisive) for (const l of p.legs) legEdges.push(l.edge);
  const avgLegsEdge =
    legEdges.length > 0
      ? +(legEdges.reduce((s, e) => s + e, 0) / legEdges.length).toFixed(4)
      : null;

  return {
    startingBankrollUsd: start,
    equityUsd: +(start + realizedPnlUsd).toFixed(2),
    realizedPnlUsd: +realizedPnlUsd.toFixed(2),
    roiPct: +((realizedPnlUsd / start) * 100).toFixed(2),
    settledCount: parlays.length,
    wins,
    losses,
    voids,
    winRatePct: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : null,
    totalStakedUsd: +totalStakedUsd.toFixed(2),
    yieldPct: totalStakedUsd > 0 ? +((realizedPnlUsd / totalStakedUsd) * 100).toFixed(2) : null,
    avgLegsEdge,
  };
}
