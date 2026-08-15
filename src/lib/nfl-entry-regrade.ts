// nfl-entry-regrade.ts — re-grade the walked NFL record at OPENING lines
// (2026-08-15 research, recs 1 + 8).
//
// The loop's graded record uses nflverse lines, which are ~closing. A signal
// selected and graded at the close embeds closing-line lookahead — nfelo's
// public backtest loses 3.6pp ATS moving from open-grading to close-grading.
// This module joins the free SBR odds archive (verified per-game OPEN and
// CLOSE spreads/totals + closing moneylines, 2011-2021) onto the graded rows
// and answers: does the doctrine survive at prices you could actually bet?
//
// Frozen anchors (deterministic checks the analysis cannot pass without):
//   1. join coverage ≥ MIN_JOIN_COVERAGE of graded games in archive seasons
//   2. corr(archive close spread, nflverse spread) ≥ MIN_CLOSE_CORR
//   3. stored results reproduce from scores at nflverse lines ≥ MIN_REGRADE_AGREEMENT
// If any anchor fails, the report throws — a silently broken join must never
// produce a doctrine verdict.

import * as fs from "node:fs";
import * as path from "node:path";

import { devigTwoWay } from "./nfl-devig";
import { posteriorMeanWinRate } from "./nfl-calibration";
import {
  defaultStateDir,
  type GameRow,
  type GradedRow,
} from "./nfl-loop";

export const MIN_JOIN_COVERAGE = 0.95;
export const MIN_CLOSE_CORR = 0.97;
export const MIN_OPEN_CORR = 0.85; // opens legitimately differ from closes
export const MIN_REGRADE_AGREEMENT = 0.99;
const BREAKEVEN_110 = 110 / 210; // 0.5238
const UNIT_WIN_110 = 100 / 110; // profit units on a -110 win

// ─── Archive loading ─────────────────────────────────────────────────────────

export interface ArchiveGame {
  season: number;
  date: number; // YYYYMMDD
  homeFranchise: string;
  awayFranchise: string;
  homeFinal: number;
  awayFinal: number;
  homeOpenSpread: number; // negative = home favored (verified convention)
  /** null when the source row is corrupt — ~10% of SBR rows carry the TOTAL
   *  in the close-spread cell (favorite/dog column swap, verified against
   *  nflverse on 75/80 corrupt rows). The sign is unrecoverable without
   *  borrowing nflverse's close, which would defeat the independent check,
   *  so corrupt closes are nulled, never repaired. Opens are unaffected
   *  (a plausible spread ≤20 cannot be a total; totals run 30-60). */
  homeCloseSpread: number | null;
  openTotal: number;
  closeTotal: number | null;
  homeCloseMl: number | null;
  awayCloseMl: number | null;
}

const SPREAD_PLAUSIBLE = (v: number): boolean => Math.abs(v) <= 20;
const TOTAL_PLAUSIBLE = (v: number): boolean => v >= 20 && v <= 70;

/** Archive nicknames → stable franchise keys. Includes every variant and typo
 *  observed in the 2019+ slice (Washingtom, KCChiefs, Fortyniners, ...). */
const NICKNAME_TO_FRANCHISE: Record<string, string> = {
  Cardinals: "cardinals",
  Falcons: "falcons",
  Ravens: "ravens",
  Bills: "bills",
  Panthers: "panthers",
  Bears: "bears",
  Bengals: "bengals",
  Browns: "browns",
  Cowboys: "cowboys",
  Broncos: "broncos",
  Lions: "lions",
  Packers: "packers",
  Texans: "texans",
  Colts: "colts",
  Jaguars: "jaguars",
  Chiefs: "chiefs",
  Kansas: "chiefs",
  KCChiefs: "chiefs",
  Chargers: "chargers",
  Rams: "rams",
  Raiders: "raiders",
  Oakland: "raiders",
  LVRaiders: "raiders",
  Dolphins: "dolphins",
  Vikings: "vikings",
  Patriots: "patriots",
  Saints: "saints",
  Giants: "giants",
  Jets: "jets",
  Eagles: "eagles",
  Steelers: "steelers",
  Fortyniners: "49ers",
  "49ers": "49ers",
  Niners: "49ers",
  Seahawks: "seahawks",
  Buccaneers: "buccaneers",
  Tampa: "buccaneers",
  Titans: "titans",
  Commanders: "commanders",
  Washington: "commanders",
  Washingtom: "commanders",
  Redskins: "commanders",
};

/** nflverse team abbreviations → the same franchise keys (all variants). */
const ABBR_TO_FRANCHISE: Record<string, string> = {
  ARI: "cardinals",
  ATL: "falcons",
  BAL: "ravens",
  BUF: "bills",
  CAR: "panthers",
  CHI: "bears",
  CIN: "bengals",
  CLE: "browns",
  DAL: "cowboys",
  DEN: "broncos",
  DET: "lions",
  GB: "packers",
  HOU: "texans",
  IND: "colts",
  JAX: "jaguars",
  JAC: "jaguars",
  KC: "chiefs",
  LAC: "chargers",
  SD: "chargers",
  LA: "rams",
  LAR: "rams",
  STL: "rams",
  LV: "raiders",
  OAK: "raiders",
  MIA: "dolphins",
  MIN: "vikings",
  NE: "patriots",
  NO: "saints",
  NYG: "giants",
  NYJ: "jets",
  PHI: "eagles",
  PIT: "steelers",
  SF: "49ers",
  SEA: "seahawks",
  TB: "buccaneers",
  TEN: "titans",
  WAS: "commanders",
  WSH: "commanders",
};

export function franchiseOfAbbr(abbr: string): string | null {
  return ABBR_TO_FRANCHISE[abbr.toUpperCase()] ?? null;
}

export function defaultArchivePath(dir = defaultStateDir()): string {
  return path.join(dir, "odds-archive", "nfl_archive_10Y.json");
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export interface ArchiveLoad {
  rows: ArchiveGame[];
  rawCount: number;
  droppedCount: number; // unknown team, missing/implausible OPEN lines
  nulledCloseCount: number; // kept, but close spread or total was corrupt
}

/** Load + normalize the SBR archive with drop/null accounting, so archive
 *  degradation is visible BEFORE the coverage anchor has to catch it. */
export function loadOddsArchiveDetailed(
  filePath = defaultArchivePath(),
): ArchiveLoad {
  const rows = loadOddsArchiveRaw(filePath);
  return rows;
}

/** Load + normalize the SBR archive. Rows with unknown teams or missing core
 *  lines are dropped. */
export function loadOddsArchive(filePath = defaultArchivePath()): ArchiveGame[] {
  return loadOddsArchiveRaw(filePath).rows;
}

function loadOddsArchiveRaw(filePath: string): ArchiveLoad {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Array<
    Record<string, unknown>
  >;
  const out: ArchiveGame[] = [];
  let nulledCloseCount = 0;
  for (const r of raw) {
    const homeFranchise = NICKNAME_TO_FRANCHISE[String(r.home_team)];
    const awayFranchise = NICKNAME_TO_FRANCHISE[String(r.away_team)];
    const season = num(r.season);
    const date = num(r.date);
    const homeOpenSpread = num(r.home_open_spread);
    const homeCloseSpread = num(r.home_close_spread);
    const openTotal = num(r.open_over_under);
    const closeTotal = num(r.close_over_under);
    const homeFinal = num(r.home_final);
    const awayFinal = num(r.away_final);
    // Entry (open) lines are required and must be plausible — they are the
    // whole point of the re-grade. Close lines are optional extras.
    if (
      !homeFranchise ||
      !awayFranchise ||
      season == null ||
      date == null ||
      homeOpenSpread == null ||
      openTotal == null ||
      homeFinal == null ||
      awayFinal == null ||
      !SPREAD_PLAUSIBLE(homeOpenSpread) ||
      !TOTAL_PLAUSIBLE(openTotal)
    ) {
      continue;
    }
    const cleanCloseSpread =
      homeCloseSpread != null && SPREAD_PLAUSIBLE(homeCloseSpread)
        ? homeCloseSpread
        : null;
    const cleanCloseTotal =
      closeTotal != null && TOTAL_PLAUSIBLE(closeTotal) ? closeTotal : null;
    if (cleanCloseSpread == null || cleanCloseTotal == null) nulledCloseCount++;
    out.push({
      season,
      date,
      homeFranchise,
      awayFranchise,
      homeFinal,
      awayFinal,
      homeOpenSpread,
      homeCloseSpread: cleanCloseSpread,
      openTotal,
      closeTotal: cleanCloseTotal,
      homeCloseMl: num(r.home_close_ml),
      awayCloseMl: num(r.away_close_ml),
    });
  }
  return {
    rows: out,
    rawCount: raw.length,
    droppedCount: raw.length - out.length,
    nulledCloseCount,
  };
}

// ─── Join ────────────────────────────────────────────────────────────────────

const dayMs = 24 * 60 * 60 * 1000;

function ymdToMs(ymd: number): number {
  const s = String(ymd);
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}

function gamedayToMs(gameday: string): number {
  const [y, m, d] = gameday.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export interface ArchiveJoin {
  byGameId: Map<string, ArchiveGame>;
  matched: number;
  eligible: number; // graded-record games within archive season coverage
  coverage: number;
  closeSpreadCorr: number; // archive close vs nflverse close, valid closes only
  openSpreadCorr: number; // archive OPEN vs nflverse close — catches bad opens
  unmatchedGameIds: string[];
}

/** Join archive rows to nflverse games on (home franchise, date ±1 day).
 *  Also computes the close-vs-close spread correlation anchor. */
export function joinArchive(
  games: GameRow[],
  archive: ArchiveGame[],
): ArchiveJoin {
  const seasons = new Set(archive.map((a) => a.season));
  const index = new Map<string, ArchiveGame>();
  for (const a of archive) {
    index.set(`${a.homeFranchise}|${ymdToMs(a.date)}`, a);
  }
  const byGameId = new Map<string, ArchiveGame>();
  const unmatched: string[] = [];
  let eligible = 0;
  const closeXs: number[] = [];
  const closeYs: number[] = [];
  const openXs: number[] = [];
  const openYs: number[] = [];
  for (const g of games) {
    if (!seasons.has(g.season)) continue;
    const franchise = franchiseOfAbbr(g.homeTeam);
    if (!franchise) continue;
    eligible++;
    const ms = gamedayToMs(g.gameday);
    const hit =
      index.get(`${franchise}|${ms}`) ??
      index.get(`${franchise}|${ms - dayMs}`) ??
      index.get(`${franchise}|${ms + dayMs}`);
    if (!hit) {
      unmatched.push(g.gameId);
      continue;
    }
    byGameId.set(g.gameId, hit);
    if (g.spreadLine != null) {
      if (hit.homeCloseSpread != null) {
        closeXs.push(hit.homeCloseSpread);
        closeYs.push(g.spreadLine);
      }
      openXs.push(hit.homeOpenSpread);
      openYs.push(g.spreadLine);
    }
  }
  return {
    byGameId,
    matched: byGameId.size,
    eligible,
    coverage: eligible > 0 ? byGameId.size / eligible : 0,
    closeSpreadCorr: correlation(closeXs, closeYs),
    openSpreadCorr: correlation(openXs, openYs),
    unmatchedGameIds: unmatched,
  };
}

export function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// ─── Grading primitives (same conventions as nfl-loop: negative spread =
//     home favored; home covers when margin + spreadHome > 0) ────────────────

export type Outcome = "win" | "loss" | "push";

export function gradeAtsAt(
  side: "home" | "away",
  spreadHome: number,
  homeMargin: number,
): Outcome {
  const coverMargin = homeMargin + spreadHome;
  if (coverMargin === 0) return "push";
  const homeCovers = coverMargin > 0;
  return (side === "home") === homeCovers ? "win" : "loss";
}

export function gradeTotalAt(
  side: "over" | "under",
  line: number,
  totalPoints: number,
): Outcome {
  if (totalPoints === line) return "push";
  const overHits = totalPoints > line;
  return (side === "over") === overHits ? "win" : "loss";
}

export function favoredAt(
  side: "home" | "away",
  spreadHome: number,
): "favorite" | "underdog" | "pickem" {
  if (spreadHome === 0) return "pickem";
  const homeIsFavorite = spreadHome < 0;
  return (side === "home") === homeIsFavorite ? "favorite" : "underdog";
}

// ─── Statistics: one-sided exact binomial + Holm-Bonferroni ─────────────────

const logFactCache: number[] = [0];
function logFact(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) {
    logFactCache.push(logFactCache[i - 1] + Math.log(i));
  }
  return logFactCache[n];
}

/** One-sided exact binomial: P(X ≥ wins | n, p0). Tests "better than
 *  breakeven", p0 defaulting to the -110 threshold. */
export function binomialPValue(
  wins: number,
  n: number,
  p0 = BREAKEVEN_110,
): number {
  if (n === 0) return 1;
  let p = 0;
  for (let k = wins; k <= n; k++) {
    p += Math.exp(
      logFact(n) -
        logFact(k) -
        logFact(n - k) +
        k * Math.log(p0) +
        (n - k) * Math.log(1 - p0),
    );
  }
  return Math.min(1, p);
}

/** Holm-Bonferroni step-down: returns per-cell significance at alpha. */
export function holmSignificant(
  pValues: number[],
  alpha = 0.05,
): boolean[] {
  const order = pValues
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p);
  const out = new Array<boolean>(pValues.length).fill(false);
  const m = pValues.length;
  for (let rank = 0; rank < m; rank++) {
    const { p, i } = order[rank];
    if (p <= alpha / (m - rank)) out[i] = true;
    else break; // step-down stops at the first failure
  }
  return out;
}

// ─── The re-grade ────────────────────────────────────────────────────────────

export interface Line3 {
  wins: number;
  losses: number;
  pushes: number;
  n: number;
  winRate: number;
  roiPct: number; // flat 1u at -110 for ats/total
  posteriorMean: number;
}

export function tally(outcomes: Outcome[]): Line3 {
  let w = 0;
  let l = 0;
  let p = 0;
  for (const o of outcomes) {
    if (o === "win") w++;
    else if (o === "loss") l++;
    else p++;
  }
  const n = w + l;
  return {
    wins: w,
    losses: l,
    pushes: p,
    n,
    winRate: n > 0 ? w / n : 0,
    roiPct: n > 0 ? ((w * UNIT_WIN_110 - l) / n) * 100 : 0,
    posteriorMean: posteriorMeanWinRate(w, n),
  };
}

export interface LocalizationCell extends Line3 {
  cell: string;
  pValue: number;
  holmSignificant: boolean;
}

export interface EntryRegradeReport {
  anchors: {
    coverage: number;
    closeSpreadCorr: number;
    openSpreadCorr: number;
    regradeAgreement: number;
    pass: boolean;
  };
  scope: {
    seasons: number[];
    gradedRowsInScope: number;
    atsRows: number;
    totalRows: number;
    mlRows: number;
  };
  ats: {
    atNflverseClose: Line3;
    atArchiveClose: Line3;
    atArchiveOpen: Line3;
    dogAtClose: Line3; // favored status derived from the line being graded
    dogAtOpen: Line3;
    favAtClose: Line3;
    favAtOpen: Line3;
    /** Mean signed line move from open→close in the pick's favor (points).
     *  Positive = market moved TOWARD our side (we'd have had entry CLV);
     *  negative = we were on the side the market moved away from. */
    dogDriftTowardPickPts: number;
  };
  totals: { atNflverseClose: Line3; atArchiveClose: Line3; atArchiveOpen: Line3 };
  moneylineDogs: {
    n: number;
    /** picks whose implied break-even beats the multiplicative fair prob */
    plusEvNaive: number;
    /** ...and how many of those survive the worst-case devig envelope */
    plusEvWorstCase: number;
    record: Line3;
    avgFairGapNaiveVsWorstPp: number;
  };
  dogLocalization: LocalizationCell[]; // home/road × spread size, at OPEN
  eraAts: Array<{ season: number; all: Line3; dogs: Line3 }>; // at OPEN
}

export interface RegradeInputs {
  graded: GradedRow[];
  games: GameRow[];
  archive: ArchiveGame[];
}

export function computeEntryRegrade(inputs: RegradeInputs): EntryRegradeReport {
  const { graded, games, archive } = inputs;
  // Scope everything — join, anchors, verdicts — to the seasons that BOTH
  // have graded rows and archive coverage. Anchoring over unrelated seasons
  // would let pre-2019 join quality veto (or vouch for) a 2019-2021 verdict.
  const gradedSeasons = new Set(graded.map((r) => r.season));
  const archiveSeasons = new Set(archive.map((a) => a.season));
  const seasons = [...gradedSeasons]
    .filter((s) => archiveSeasons.has(s))
    .sort((a, b) => a - b);
  const scopeSeasons = new Set(seasons);
  const scopedGames = games.filter((g) => scopeSeasons.has(g.season));
  const scopedArchive = archive.filter((a) => scopeSeasons.has(a.season));
  const join = joinArchive(scopedGames, scopedArchive);
  const gameById = new Map(scopedGames.map((g) => [g.gameId, g]));

  // Scope: graded rows whose game is matched in the archive and has scores.
  type Row = { row: GradedRow; game: GameRow; arch: ArchiveGame };
  const rows: Row[] = [];
  let agreeChecked = 0;
  let agreeHit = 0;
  for (const row of graded) {
    if (!scopeSeasons.has(row.season)) continue;
    const game = gameById.get(row.gameId);
    const arch = join.byGameId.get(row.gameId);
    if (!game || !arch) continue;
    if (game.homeScore == null || game.awayScore == null) continue;
    rows.push({ row, game, arch });
  }

  const homeMargin = (g: GameRow): number =>
    (g.homeScore as number) - (g.awayScore as number);
  const totalPts = (g: GameRow): number =>
    (g.homeScore as number) + (g.awayScore as number);

  // Anchor 3: stored results must reproduce at nflverse lines from raw scores.
  for (const { row, game } of rows) {
    if (row.market === "ats" && game.spreadLine != null) {
      const re = gradeAtsAt(
        row.side as "home" | "away",
        game.spreadLine,
        homeMargin(game),
      );
      agreeChecked++;
      if (re === row.result) agreeHit++;
    } else if (row.market === "total" && game.totalLine != null) {
      const re = gradeTotalAt(
        row.side as "over" | "under",
        game.totalLine,
        totalPts(game),
      );
      agreeChecked++;
      if (re === row.result) agreeHit++;
    }
  }
  const regradeAgreement = agreeChecked > 0 ? agreeHit / agreeChecked : 0;

  const anchors = {
    coverage: join.coverage,
    closeSpreadCorr: join.closeSpreadCorr,
    openSpreadCorr: join.openSpreadCorr,
    regradeAgreement,
    pass:
      join.coverage >= MIN_JOIN_COVERAGE &&
      join.closeSpreadCorr >= MIN_CLOSE_CORR &&
      join.openSpreadCorr >= MIN_OPEN_CORR &&
      regradeAgreement >= MIN_REGRADE_AGREEMENT,
  };
  if (!anchors.pass) {
    throw new Error(
      `entry-regrade anchors FAILED — coverage ${(join.coverage * 100).toFixed(1)}% ` +
        `(need ≥${MIN_JOIN_COVERAGE * 100}%), closeSpreadCorr ${join.closeSpreadCorr.toFixed(3)} ` +
        `(need ≥${MIN_CLOSE_CORR}), openSpreadCorr ${join.openSpreadCorr.toFixed(3)} ` +
        `(need ≥${MIN_OPEN_CORR}), regradeAgreement ${(regradeAgreement * 100).toFixed(1)}% ` +
        `(need ≥${MIN_REGRADE_AGREEMENT * 100}%). A broken join must not produce a verdict.`,
    );
  }

  // ATS re-grades.
  const atsRows = rows.filter((r) => r.row.market === "ats");
  const atsSide = (r: Row): "home" | "away" => r.row.side as "home" | "away";

  const atsClose = atsRows
    .filter((r) => r.game.spreadLine != null)
    .map((r) => gradeAtsAt(atsSide(r), r.game.spreadLine as number, homeMargin(r.game)));
  const atsWithArchClose = atsRows.filter((r) => r.arch.homeCloseSpread != null);
  const atsArchClose = atsWithArchClose.map((r) =>
    gradeAtsAt(atsSide(r), r.arch.homeCloseSpread as number, homeMargin(r.game)),
  );
  const atsOpen = atsRows.map((r) =>
    gradeAtsAt(atsSide(r), r.arch.homeOpenSpread, homeMargin(r.game)),
  );

  // Close-side dog/fav splits use the nflverse close (authoritative, complete)
  // rather than the archive's partially-corrupt close column.
  const dogClose = atsRows.filter(
    (r) =>
      r.game.spreadLine != null &&
      favoredAt(atsSide(r), r.game.spreadLine) === "underdog",
  );
  const dogOpen = atsRows.filter(
    (r) => favoredAt(atsSide(r), r.arch.homeOpenSpread) === "underdog",
  );
  const favClose = atsRows.filter(
    (r) =>
      r.game.spreadLine != null &&
      favoredAt(atsSide(r), r.game.spreadLine) === "favorite",
  );
  const favOpen = atsRows.filter(
    (r) => favoredAt(atsSide(r), r.arch.homeOpenSpread) === "favorite",
  );

  // Signed open→close drift toward the picked side, on open-line dogs.
  // For a home pick, spread improving for home = closeSpreadHome > openSpreadHome
  // (e.g. +3.5 → +4.5); drift = (close − open) for home picks, negated for away.
  // nflverse close used as the close (complete + authoritative).
  const drift = dogOpen
    .filter((r) => r.game.spreadLine != null)
    .map((r) => {
      const d = (r.game.spreadLine as number) - r.arch.homeOpenSpread;
      return atsSide(r) === "home" ? d : -d;
    });
  const dogDriftTowardPickPts =
    drift.length > 0 ? drift.reduce((a, b) => a + b, 0) / drift.length : 0;

  // Totals re-grades.
  const totRows = rows.filter((r) => r.row.market === "total");
  const totSide = (r: Row): "over" | "under" => r.row.side as "over" | "under";
  const totClose = totRows
    .filter((r) => r.game.totalLine != null)
    .map((r) => gradeTotalAt(totSide(r), r.game.totalLine as number, totalPts(r.game)));
  const totArchClose = totRows
    .filter((r) => r.arch.closeTotal != null)
    .map((r) =>
      gradeTotalAt(totSide(r), r.arch.closeTotal as number, totalPts(r.game)),
    );
  const totOpen = totRows.map((r) =>
    gradeTotalAt(totSide(r), r.arch.openTotal, totalPts(r.game)),
  );

  // Moneyline dogs under the devig envelope (rec 7). The record's implied
  // "edge" was confidence vs naive fair prob; count how many dog picks lose
  // their +EV status when fair prob comes from the worst-case method.
  const mlDogRows = rows.filter(
    (r) =>
      r.row.market === "moneyline" &&
      r.row.favored === "underdog" &&
      r.arch.homeCloseMl != null &&
      r.arch.awayCloseMl != null,
  );
  let plusEvNaive = 0;
  let plusEvWorstCase = 0;
  let fairGapSum = 0;
  for (const r of mlDogRows) {
    const side = r.row.side as "home" | "away";
    const mlA = side === "home" ? r.arch.homeCloseMl! : r.arch.awayCloseMl!;
    const mlB = side === "home" ? r.arch.awayCloseMl! : r.arch.homeCloseMl!;
    const devig = devigTwoWay(mlA, mlB);
    const conf = r.row.confidence;
    if (conf > devig.byMethod.multiplicative) plusEvNaive++;
    if (conf > devig.worstCaseA) plusEvWorstCase++;
    fairGapSum += devig.byMethod.multiplicative - devig.worstCaseA;
  }
  const mlDogOutcomes = mlDogRows.map((r) => r.row.result as Outcome);

  // Localization (rec 8): open-line dogs, home/road × dog-spread size.
  const sizeBin = (dogSpread: number): string =>
    dogSpread <= 3 ? "+0.5 to +3" : dogSpread <= 6.5 ? "+3.5 to +6.5" : "+7 or more";
  const cells = new Map<string, Outcome[]>();
  for (const r of dogOpen) {
    const side = atsSide(r);
    const dogSpread =
      side === "home" ? r.arch.homeOpenSpread : -r.arch.homeOpenSpread;
    const cell = `${side === "home" ? "home dog" : "road dog"} ${sizeBin(dogSpread)}`;
    const arr = cells.get(cell) ?? [];
    arr.push(gradeAtsAt(side, r.arch.homeOpenSpread, homeMargin(r.game)));
    cells.set(cell, arr);
  }
  const cellEntries = [...cells.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const pValues = cellEntries.map(([, outs]) => {
    const t = tally(outs);
    return binomialPValue(t.wins, t.n);
  });
  const sig = holmSignificant(pValues);
  const dogLocalization: LocalizationCell[] = cellEntries.map(
    ([cell, outs], i) => ({
      cell,
      ...tally(outs),
      pValue: pValues[i],
      holmSignificant: sig[i],
    }),
  );

  // Era table (rec 8): per-season, graded at OPEN.
  const eraAts = seasons
    .filter((s) => atsRows.some((r) => r.row.season === s))
    .map((season) => {
      const inSeason = atsRows.filter((r) => r.row.season === season);
      return {
        season,
        all: tally(
          inSeason.map((r) =>
            gradeAtsAt(atsSide(r), r.arch.homeOpenSpread, homeMargin(r.game)),
          ),
        ),
        dogs: tally(
          inSeason
            .filter((r) => favoredAt(atsSide(r), r.arch.homeOpenSpread) === "underdog")
            .map((r) =>
              gradeAtsAt(atsSide(r), r.arch.homeOpenSpread, homeMargin(r.game)),
            ),
        ),
      };
    });

  return {
    anchors,
    scope: {
      seasons,
      gradedRowsInScope: rows.length,
      atsRows: atsRows.length,
      totalRows: totRows.length,
      mlRows: rows.filter((r) => r.row.market === "moneyline").length,
    },
    ats: {
      atNflverseClose: tally(atsClose),
      atArchiveClose: tally(atsArchClose),
      atArchiveOpen: tally(atsOpen),
      dogAtClose: tally(
        dogClose.map((r) =>
          gradeAtsAt(atsSide(r), r.game.spreadLine as number, homeMargin(r.game)),
        ),
      ),
      dogAtOpen: tally(
        dogOpen.map((r) =>
          gradeAtsAt(atsSide(r), r.arch.homeOpenSpread, homeMargin(r.game)),
        ),
      ),
      favAtClose: tally(
        favClose.map((r) =>
          gradeAtsAt(atsSide(r), r.game.spreadLine as number, homeMargin(r.game)),
        ),
      ),
      favAtOpen: tally(
        favOpen.map((r) =>
          gradeAtsAt(atsSide(r), r.arch.homeOpenSpread, homeMargin(r.game)),
        ),
      ),
      dogDriftTowardPickPts,
    },
    totals: {
      atNflverseClose: tally(totClose),
      atArchiveClose: tally(totArchClose),
      atArchiveOpen: tally(totOpen),
    },
    moneylineDogs: {
      n: mlDogRows.length,
      plusEvNaive,
      plusEvWorstCase,
      record: tally(mlDogOutcomes),
      avgFairGapNaiveVsWorstPp:
        mlDogRows.length > 0 ? (fairGapSum / mlDogRows.length) * 100 : 0,
    },
    dogLocalization,
    eraAts,
  };
}
