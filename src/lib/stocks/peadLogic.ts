/**
 * peadLogic.ts — pure logic for the PEAD stock paper book (Experiment No. 3).
 * Pre-registered rule lives in PEAD_PAPER_SPEC.md — do not tune after launch.
 * Pure module — no fetch, no DB — so every decision stays unit-testable.
 */

export const PEAD_CONFIG = {
  bookUsd: 10_000,
  perPositionUsd: 500,
  maxConcurrent: 20,
  minSurprisePct: 20, // EPS surprise ≥ +20% (long side only)
  minAbsEstimate: 0.05, // guard tiny denominators faking "extreme" surprises
  minPrice: 5,
  minAvgDollarVolume: 250_000, // IEX-only volume (~30–50× under consolidated)
  holdCalendarDays: 28, // ≈ 20 trading days
  killMinSettles: 40,
  benchmarkSymbol: "SPY",
} as const;

/** EPS surprise %, or null when the estimate is too small to divide by. */
export function surprisePct(epsEstimate: number, epsActual: number): number | null {
  if (!Number.isFinite(epsEstimate) || !Number.isFinite(epsActual)) return null;
  if (Math.abs(epsEstimate) < PEAD_CONFIG.minAbsEstimate) return null;
  return ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100;
}

export interface EarningsReport {
  symbol: string;
  date: string; // YYYY-MM-DD
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
}

/** Does a report qualify for the long-PEAD entry signal? (price/liquidity gated later) */
export function qualifies(r: EarningsReport): { ok: boolean; surprise: number | null } {
  if (r.epsEstimate == null || r.epsActual == null) return { ok: false, surprise: null };
  const s = surprisePct(r.epsEstimate, r.epsActual);
  // Epsilon so float error can't flip an exact-threshold beat (1.2 vs 1.0
  // computes to 19.999999999999996, not 20).
  return { ok: s != null && s >= PEAD_CONFIG.minSurprisePct - 1e-9, surprise: s };
}

/** [from, to] YYYY-MM-DD covering yesterday's AMC + today's BMO reports. */
export function calendarRange(now: Date): { from: string; to: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return { from: day(yesterday), to: day(now) };
}

export function exitDueISO(openedAt: string, holdCalendarDays = PEAD_CONFIG.holdCalendarDays): string {
  return new Date(Date.parse(openedAt) + holdCalendarDays * 24 * 60 * 60 * 1000).toISOString();
}

export function isExitDue(exitDue: string, now: Date): boolean {
  const t = Date.parse(exitDue);
  return Number.isFinite(t) && now.getTime() >= t;
}

/** Excess return vs the benchmark over the identical window, in percent. */
export function excessReturnPct(
  entry: number,
  exit: number,
  benchEntry: number | null,
  benchExit: number | null,
): number | null {
  if (entry <= 0 || exit <= 0) return null;
  const stockRet = exit / entry - 1;
  if (benchEntry == null || benchExit == null || benchEntry <= 0 || benchExit <= 0) {
    return stockRet * 100; // no benchmark leg captured — raw return, flagged upstream
  }
  return (stockRet - (benchExit / benchEntry - 1)) * 100;
}

/** Mean + one-sample t-stat (vs 0) — drives the pre-registered kill criterion. */
export function meanTStat(xs: number[]): { n: number; mean: number | null; t: number | null } {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, t: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { n, mean, t: null };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return { n, mean, t: se > 0 ? mean / se : null };
}

export type KillVerdict = "accumulating" | "kill" | "validated" | "extend";

/** The pre-registered decision rule (PEAD_PAPER_SPEC.md). */
export function killVerdict(excess: number[]): KillVerdict {
  const { n, mean, t } = meanTStat(excess);
  if (n < PEAD_CONFIG.killMinSettles || mean == null) return "accumulating";
  if (mean <= 0) return "kill";
  if (t != null && t >= 2) return "validated";
  return n >= 80 ? "kill" : "extend";
}
