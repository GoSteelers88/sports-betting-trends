// nfl-clv-metric.ts — the receipts page's verdict metric, made honest
// (2026-08-15 research, rec 2).
//
// Three rules, mechanically enforced here:
//   1. CLV is computed against the VIG-FREE close — raw line-vs-line CLV
//      overstates edge 3-5× (a -195 entry vs a -220 close reads ~+4% raw but
//      <1% devigged). Both numbers are returned; the devigged one decides.
//   2. The closing benchmark must be a SHARP book (Pinnacle; Circa/BookMaker
//      fallback) — devigged soft-book or consensus closes predict nothing
//      (Buchdahl, 136,876-match dataset). The benchmark book is stored on
//      every verdict for auditability.
//   3. Props are NEVER graded by CLV (low-limit closes are not efficient
//      prices) — they get realized results with a Wilson interval instead.
//
// Dual ledger: an angle is killed only when devigged CLV AND realized ROI are
// both negative — orthogonal-information edges can flunk CLV while winning.

import {
  americanToDecimal,
  americanToImplied,
  devigTwoWay,
  type DevigMethod,
} from "./nfl-devig";
import { wilsonInterval } from "./nfl-calibration";

/** Benchmark chain, re-pre-registered 2026-08-29 BEFORE the first published
 *  board (threat T1/T16). The original chain ["pinnacle","circa","bookmaker"]
 *  had no data source: across every Odds API snapshot this repo ever captured
 *  there is zero Pinnacle (eu-region only), zero Circa, zero BookMaker (not
 *  sold at any tier) — the verdict metric would have computed n=0 forever.
 *
 *  Tier 1 — pinnacle, via our own guest-API scrape (scripts/scrape-pinnacle.ts,
 *    NFL leagueId 889). The headline benchmark.
 *  Tier 2 — lowvig, betonlineag: low-vig Pinnacle-adjacent books that DO
 *    appear in our Odds API captures. Used only when no Pinnacle close was
 *    captured for a leg; every tier-2-benchmarked verdict is flagged and
 *    counted separately so the substitution is visible, never silent.
 *  Everything else (FanDuel/DK/MGM/…) is a soft close: recorded if captured,
 *  EXCLUDED from the metric (Buchdahl: devigged soft closes predict nothing).
 *
 *  The priority order is frozen; a captured close from a higher tier always
 *  wins. Changing this list after boards publish voids the season's metric. */
export const BENCHMARK_TIERS: Readonly<Record<string, 1 | 2>> = {
  pinnacle: 1,
  lowvig: 2,
  betonlineag: 2,
};

export const SHARP_BENCHMARK_BOOKS = Object.keys(
  BENCHMARK_TIERS,
) as readonly string[];

export function benchmarkTier(book: string): 1 | 2 | null {
  return BENCHMARK_TIERS[book.trim().toLowerCase()] ?? null;
}

export function isSharpBenchmark(book: string): boolean {
  return benchmarkTier(book) !== null;
}

export interface ClosingBenchmark {
  /** Book the two-sided close came from — stored, not assumed. */
  book: string;
  /** Closing price of OUR side. */
  sideAmerican: number;
  /** Closing price of the other side — required; devig needs both. */
  otherAmerican: number;
}

export interface ClvVerdict {
  /** Line-vs-line CLV in probability points — published for transparency,
   *  never used for the verdict. */
  rawClvPp: number;
  /** Devigged fair probability of our side at the close. */
  fairCloseProb: number;
  /** fairCloseProb − implied(entry), in probability points. The honest CLV. */
  devigClvPp: number;
  /** devigClvPp > 0 — the beat-rate numerator. */
  beatClose: boolean;
  /** Expected value of the ENTRY price judged at the fair close. */
  evAtClosePct: number;
  method: DevigMethod;
  benchmarkBook: string;
  benchmarkIsSharp: boolean;
  /** 1 = pinnacle, 2 = low-vig fallback, null = soft (excluded). */
  benchmarkTier: 1 | 2 | null;
}

/** Score one settled-market entry against a sharp two-sided close.
 *  Method defaults to "power" (odds-weighted family — rec 7); the naive
 *  multiplicative number would flatter longshots. */
export function clvVerdict(
  entryAmerican: number,
  close: ClosingBenchmark,
  method: DevigMethod = "power",
): ClvVerdict {
  const entryImplied = americanToImplied(entryAmerican);
  const closeImplied = americanToImplied(close.sideAmerican);
  const fair = devigTwoWay(close.sideAmerican, close.otherAmerican).byMethod[
    method
  ];
  return {
    rawClvPp: (closeImplied - entryImplied) * 100,
    fairCloseProb: fair,
    devigClvPp: (fair - entryImplied) * 100,
    beatClose: fair > entryImplied,
    evAtClosePct: (fair * americanToDecimal(entryAmerican) - 1) * 100,
    method,
    benchmarkBook: close.book,
    benchmarkIsSharp: isSharpBenchmark(close.book),
    benchmarkTier: benchmarkTier(close.book),
  };
}

export interface BeatRateSummary {
  /** Verdicts counted in the metric — sharp benchmarks ONLY. */
  n: number;
  beats: number;
  beatRate: number;
  beatRateWilson95: { low: number; high: number };
  avgDevigClvPp: number;
  avgRawClvPp: number; // published alongside so the flattery is visible
  /** Verdicts EXCLUDED because their close came from a non-sharp book.
   *  Should be 0 in a healthy capture pipeline — a nonzero value means a
   *  soft-book feed leaked into the benchmark and was refused, not counted. */
  nonSharpExcluded: number;
  /** Counted verdicts whose benchmark was a tier-2 (low-vig fallback) close
   *  rather than Pinnacle — rendered next to n so substitution is visible. */
  tier2Benchmarked: number;
}

/** Aggregate verdicts into the pre-registered metric (target: beat rate ≥55%,
 *  avg devigged CLV ≥ +1.0pp at n≥150). Non-sharp-benchmark verdicts are
 *  EXCLUDED from every number here (devigged soft closes predict nothing);
 *  they surface only in the nonSharpExcluded audit counter. */
export function summarizeBeatRate(verdicts: ClvVerdict[]): BeatRateSummary {
  const sharp = verdicts.filter((v) => v.benchmarkIsSharp);
  const n = sharp.length;
  const beats = sharp.filter((v) => v.beatClose).length;
  const wilson = wilsonInterval(beats, n);
  const avg = (f: (v: ClvVerdict) => number): number =>
    n > 0 ? sharp.reduce((s, v) => s + f(v), 0) / n : 0;
  return {
    n,
    beats,
    beatRate: n > 0 ? beats / n : 0,
    beatRateWilson95: { low: wilson.low, high: wilson.high },
    avgDevigClvPp: avg((v) => v.devigClvPp),
    avgRawClvPp: avg((v) => v.rawClvPp),
    nonSharpExcluded: verdicts.length - n,
    tier2Benchmarked: sharp.filter((v) => v.benchmarkTier === 2).length,
  };
}

// ─── Props: realized results only ───────────────────────────────────────────

export interface PropOutcomeRow {
  result: "win" | "loss" | "push";
  /** Actual entry price; -110 default matches the walk's assumption. */
  oddsAmerican?: number;
}

export interface PropsRealizedVerdict {
  n: number; // decided (pushes excluded)
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  winRateWilson95: { low: number; high: number };
  roiPct: number; // flat 1u at each row's actual odds
}

/** The props verdict: realized record + Wilson CI + flat-stake ROI.
 *  There is deliberately NO CLV field here. */
export function propsRealizedVerdict(
  rows: PropOutcomeRow[],
): PropsRealizedVerdict {
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let pnl = 0;
  for (const r of rows) {
    const odds = r.oddsAmerican ?? -110;
    if (r.result === "win") {
      wins++;
      pnl += americanToDecimal(odds) - 1;
    } else if (r.result === "loss") {
      losses++;
      pnl -= 1;
    } else pushes++;
  }
  const n = wins + losses;
  const wilson = wilsonInterval(wins, n);
  return {
    n,
    wins,
    losses,
    pushes,
    winRate: n > 0 ? wins / n : 0,
    winRateWilson95: { low: wilson.low, high: wilson.high },
    roiPct: n > 0 ? (pnl / n) * 100 : 0,
  };
}

// ─── Dual ledger ─────────────────────────────────────────────────────────────

export type AngleHealth = "healthy" | "watch" | "dead";

/** Kill an angle only when BOTH ledgers are negative (rec 2's dual-ledger
 *  rule): devigged CLV can flunk an orthogonal-information edge that realized
 *  ROI vindicates, and vice versa. One negative ledger = watch. Below minN
 *  the answer is always "watch" — three verdicts cannot kill an angle. */
export function angleHealth(
  beatRate: number,
  realizedRoiPct: number,
  n = Number.MAX_SAFE_INTEGER,
  minN = 50,
): AngleHealth {
  if (n < minN) return "watch";
  const clvNegative = beatRate < 0.5;
  const roiNegative = realizedRoiPct < 0;
  if (clvNegative && roiNegative) return "dead";
  if (clvNegative || roiNegative) return "watch";
  return "healthy";
}
