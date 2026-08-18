// nfl-validation.ts — the 2025 HOLDOUT validation (season-plan gate).
//
// 2025 was held out of LOOP_SEASONS for exactly one purpose: a single
// out-of-sample run that answers "does the doctrine distilled from 2019-2024
// transfer to a season the loop has never seen?" The number this produces is
// what the /nfl receipts page cites.
//
// What makes it a VALIDATION and not more walking:
//   - NO lessons write and NO reflect call. The rolling memo never learns from
//     2025, so week N+1 cannot benefit from week N's results. (It is also the
//     single cheapest saving available — the reflect call is pure waste here.)
//   - NO dream. 2025 results must never reach the doctrine.
//   - Its own state directory + graded log. The walk's picks-log.jsonl is
//     never touched, so the backtest record stays uncontaminated.
//   - A hard leak assert: the doctrine being injected must have coverage
//     STRICTLY BEFORE the validation season. Injecting a doctrine that had
//     seen 2025 would be grading the model on its own answers.
//
// Everything here is pure except the small fs helpers; the runner script owns
// the API calls and the budget cap.

import * as path from "node:path";

import {
  cursorAfterCoverage,
  type DoctrineCoverage,
} from "./nfl-dream";
import {
  computeStatRecord,
  defaultStateDir,
  type Cursor,
  type GameRow,
  type GradedRow,
  type Market,
  type StatRecord,
} from "./nfl-loop";
import { evaluateBucketAt, posteriorMeanWinRate } from "./nfl-calibration";

/** The held-out season. Deliberately a constant, not a CLI argument — the
 *  season plan froze 2025 as THE holdout, and a validation you can re-point
 *  at any season is a validation you can shop around until it looks good. */
export const VALIDATION_SEASON = 2025;

/** Validation state lives beside the walk's, never inside it. */
export function validationStateDir(dir = defaultStateDir()): string {
  return path.join(dir, `validation-${VALIDATION_SEASON}`);
}

/** Ordered list of every week of the validation season present in the loaded
 *  games. Built from the DATA, not from fullSchedule() — fullSchedule covers
 *  LOOP_SEASONS only, which is precisely how 2025 stayed held out. */
export function validationWeeks(
  games: GameRow[],
  season = VALIDATION_SEASON,
): Cursor[] {
  const seen = new Map<string, Cursor>();
  for (const g of games) {
    if (g.season !== season) continue;
    const phase: Cursor["phase"] = g.gameType === "REG" ? "REG" : "POST";
    const key = `${phase}|${g.week}`;
    if (!seen.has(key)) seen.set(key, { season, phase, week: g.week });
  }
  return [...seen.values()].sort((a, b) => {
    if (a.phase !== b.phase) return a.phase === "REG" ? -1 : 1;
    return a.week - b.week;
  });
}

/** THE LEAK ASSERT. The doctrine handed to the validation picker must have
 *  been distilled strictly before the validation season. Throws otherwise —
 *  a validation run against a doctrine that has seen the holdout is worse
 *  than no validation, because it looks like evidence. */
export function assertDoctrineIsPreValidation(
  coverage: DoctrineCoverage | null,
  season = VALIDATION_SEASON,
): void {
  if (coverage == null) return; // no doctrine at all — nothing can leak
  const firstWeek: Cursor = { season, phase: "REG", week: 1 };
  if (!cursorAfterCoverage(firstWeek, coverage)) {
    throw new Error(
      `LEAK GUARD: doctrine coverage is ${coverage.season} ${coverage.phase} wk${coverage.week}, ` +
        `which is not strictly before ${season} REG wk1. The doctrine has seen the holdout season; ` +
        `this run would grade the model on its own answers. Refusing.`,
    );
  }
}

/** Guard against the other direction of contamination: no validation row may
 *  ever carry a season other than the holdout. */
export function assertRowsAreHoldoutOnly(
  rows: GradedRow[],
  season = VALIDATION_SEASON,
): void {
  const strays = [...new Set(rows.map((r) => r.season))].filter(
    (s) => s !== season,
  );
  if (strays.length > 0) {
    throw new Error(
      `validation log contaminated with non-holdout season(s): ${strays.join(", ")}`,
    );
  }
}

export interface MarketLine {
  market: Market | "dogs" | "favorites";
  wins: number;
  losses: number;
  pushes: number;
  n: number;
  winRate: number;
  roiPct: number;
  /** Mean break-even implied by the rows' own prices — the honest bar. */
  breakeven: number;
  /** Beta(50,50) posterior vs that bar: the same gate the doctrine uses. */
  posteriorMean: number;
  clearsGate: boolean;
}

export interface ValidationSummary {
  season: number;
  weeks: number;
  rows: number;
  byMarket: MarketLine[];
  calibration: StatRecord["calibration"];
  calibrationGapPp: number | null;
  /** Walk-vs-holdout deltas for the headline splits, in ROI points. */
  transfer: Array<{ label: string; walkRoiPct: number; holdoutRoiPct: number; deltaPp: number }>;
}

function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 1 + 100 / 110;
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

function lineFor(label: MarketLine["market"], rows: GradedRow[]): MarketLine {
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let pnl = 0;
  let beSum = 0;
  for (const r of rows) {
    if (r.result === "win") wins++;
    else if (r.result === "loss") losses++;
    else pushes++;
    pnl += r.pnlUnits;
    if (r.result !== "push") beSum += 1 / americanToDecimal(r.oddsAmerican);
  }
  const n = wins + losses;
  const breakeven = n > 0 ? beSum / n : 0.5238;
  const posteriorMean = posteriorMeanWinRate(wins, n);
  return {
    market: label,
    wins,
    losses,
    pushes,
    n,
    winRate: n > 0 ? wins / n : 0,
    roiPct: n > 0 ? (pnl / n) * 100 : 0,
    breakeven,
    posteriorMean,
    clearsGate: evaluateBucketAt(String(label), wins, losses, pushes, breakeven)
      .eligible,
  };
}

/** Build the holdout report. `walkRows` is the 2019-2024 record, used only to
 *  compute transfer deltas — never mixed into the holdout numbers. */
export function summarizeValidation(
  holdoutRows: GradedRow[],
  walkRows: GradedRow[],
  season = VALIDATION_SEASON,
): ValidationSummary {
  assertRowsAreHoldoutOnly(holdoutRows, season);
  const pick = (rows: GradedRow[], m: Market) =>
    rows.filter((r) => r.market === m);
  const dogs = (rows: GradedRow[]) =>
    rows.filter((r) => r.market === "ats" && r.favored === "underdog");
  const favs = (rows: GradedRow[]) =>
    rows.filter((r) => r.market === "ats" && r.favored === "favorite");

  const byMarket: MarketLine[] = [
    lineFor("ats", pick(holdoutRows, "ats")),
    lineFor("moneyline", pick(holdoutRows, "moneyline")),
    lineFor("total", pick(holdoutRows, "total")),
    lineFor("dogs", dogs(holdoutRows)),
    lineFor("favorites", favs(holdoutRows)),
  ];

  const record = computeStatRecord(holdoutRows);
  const decisive = record.calibration.filter((b) => b.realized != null);
  const totalN = decisive.reduce((s, b) => s + b.n, 0);
  const calibrationGapPp =
    totalN > 0
      ? decisive.reduce(
          (s, b) => s + Math.abs((b.realized as number) - b.predicted) * 100 * b.n,
          0,
        ) / totalN
      : null;

  const transferPairs: Array<[string, (r: GradedRow[]) => GradedRow[]]> = [
    ["ATS", (r) => pick(r, "ats")],
    ["totals", (r) => pick(r, "total")],
    ["moneyline", (r) => pick(r, "moneyline")],
    ["dogs ATS", dogs],
  ];
  const transfer = transferPairs.map(([label, sel]) => {
    const walk = lineFor("ats", sel(walkRows));
    const hold = lineFor("ats", sel(holdoutRows));
    return {
      label,
      walkRoiPct: walk.roiPct,
      holdoutRoiPct: hold.roiPct,
      deltaPp: hold.roiPct - walk.roiPct,
    };
  });

  return {
    season,
    weeks: new Set(holdoutRows.map((r) => `${r.phase}|${r.week}`)).size,
    rows: holdoutRows.length,
    byMarket,
    calibration: record.calibration,
    calibrationGapPp,
    transfer,
  };
}
