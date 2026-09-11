// nfl-live-grade.ts — grade the PRIVATE live-week model board against real
// results, into a log the calibration maps can (optionally) read.
//
// Why this exists (2026-09-10 audit): the beta-calibration maps that size
// every stake and gate every PLAY (doctrine T1) are fitted from
// picks-log.jsonl — the 2015–2024 backtest. The live week writes NOTHING back
// ("NOT written to picks-log.jsonl", by design: the backtest record must stay
// uncontaminated), so a season of live reads could never inform the maps.
// This module grades the live board's reads — every leg, PLAY and PASS alike,
// because calibration is about the model's stated confidence, not the
// doctrine's verdict — into a SEPARATE log (live-graded.jsonl) in the same
// GradedRow shape. Reading it into the fit is a switch that is OFF by default
// (`--with-live-calibration` on nfl-live-week.ts): a refit is not
// tightening-only, and per-market fits need >= 20 rows, so it is inert for
// the first few weeks regardless. Logging now, deciding later, costs nothing.
//
// Pure over its inputs; the script owns fs.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  americanToProfitUnits,
  gradeAts,
  gradeMoneyline,
  gradeTotal,
  type GameRow,
  type GradedRow,
  type Market,
  type PickResult,
  type Side,
} from "./nfl-loop";

/** The subset of a private BoardLeg (scripts/nfl-live-week.ts) grading needs. */
export type LiveBoardLeg = {
  gameId: string;
  matchup: string;
  market: Market;
  selection: string; // "SEA ML" | "GB +3.5" | "OVER 44.5"
  priceAmerican: number;
  rawConfidence: number;
  verdict: "PLAY" | "PASS";
  divGame: boolean;
  dome: boolean;
};

export type ParsedSelection =
  | { market: "moneyline"; side: Side }
  | { market: "ats"; side: Side; spreadHome: number }
  | { market: "total"; side: "over" | "under"; line: number };

/** Read the side (and line) back out of the board's selection string. The
 *  team token must equal the game's home or away code — anything else is a
 *  parse failure, never a guess. */
export function parseSelection(leg: LiveBoardLeg, game: GameRow): ParsedSelection | null {
  const s = leg.selection.trim();
  if (leg.market === "moneyline") {
    const m = /^(\S+)\s+ML$/i.exec(s);
    if (!m) return null;
    const side = sideOf(m[1], game);
    return side ? { market: "moneyline", side } : null;
  }
  if (leg.market === "ats") {
    const m = /^(\S+)\s+([+-]?\d+(?:\.\d+)?)$/.exec(s);
    if (!m) return null;
    const side = sideOf(m[1], game);
    if (!side) return null;
    const sideSpread = Number(m[2]);
    if (!Number.isFinite(sideSpread)) return null;
    // Board prints the SIDE's spread ("GB +3.5"); gradeAts wants the HOME spread.
    return { market: "ats", side, spreadHome: side === "home" ? sideSpread : -sideSpread };
  }
  const m = /^(OVER|UNDER)\s+(\d+(?:\.\d+)?)$/i.exec(s);
  if (!m) return null;
  const line = Number(m[2]);
  if (!Number.isFinite(line)) return null;
  return { market: "total", side: m[1].toLowerCase() as "over" | "under", line };
}

function sideOf(token: string, game: GameRow): Side | null {
  const t = token.toUpperCase();
  if (t === game.homeTeam.toUpperCase()) return "home";
  if (t === game.awayTeam.toUpperCase()) return "away";
  return null;
}

function pnl(result: PickResult, odds: number): number {
  if (result === "push") return 0;
  return result === "win" ? americanToProfitUnits(odds) : -1;
}

function favoredFor(side: Side, spreadHome: number | null): GradedRow["favored"] {
  if (spreadHome == null || spreadHome === 0) return "pickem";
  const homeIsFavorite = spreadHome < 0;
  return (side === "home") === homeIsFavorite ? "favorite" : "underdog";
}

export type LiveGradeResult = {
  rows: GradedRow[];
  /** Legs whose game has no result yet — left for the next run. */
  pending: string[];
  /** Legs whose selection could not be parsed against the game — reported, never guessed. */
  unparsed: string[];
  /** Legs whose gameId is not in the spine at all. */
  unknownGames: string[];
};

/** Grade every leg of a private live board that has a final. Idempotent:
 *  the caller upserts by `key`. `gradedAt` is injected for testability. */
export function gradeLiveBoard(
  legs: LiveBoardLeg[],
  games: GameRow[],
  gradedAt: string,
): LiveGradeResult {
  const byId = new Map(games.map((g) => [g.gameId, g]));
  const res: LiveGradeResult = { rows: [], pending: [], unparsed: [], unknownGames: [] };
  for (const leg of legs) {
    const game = byId.get(leg.gameId);
    if (!game) {
      res.unknownGames.push(`${leg.gameId} ${leg.market}`);
      continue;
    }
    const homeMargin = game.result;
    const actualTotal = game.total;
    if (homeMargin == null || actualTotal == null) {
      res.pending.push(`${leg.gameId} ${leg.market}`);
      continue;
    }
    const parsed = parseSelection(leg, game);
    if (!parsed) {
      res.unparsed.push(`${leg.gameId} ${leg.market} "${leg.selection}"`);
      continue;
    }
    let result: PickResult;
    let side: GradedRow["side"];
    let favored: GradedRow["favored"];
    let homeAway: Side;
    let restAdvantage = 0;
    if (parsed.market === "moneyline") {
      result = gradeMoneyline(parsed.side, homeMargin);
      side = parsed.side;
      favored = favoredFor(parsed.side, game.spreadLine);
      homeAway = parsed.side;
      restAdvantage = restAdv(parsed.side, game);
    } else if (parsed.market === "ats") {
      result = gradeAts(parsed.side, parsed.spreadHome, homeMargin);
      side = parsed.side;
      favored = favoredFor(parsed.side, parsed.spreadHome);
      homeAway = parsed.side;
      restAdvantage = restAdv(parsed.side, game);
    } else {
      result = gradeTotal(parsed.side, parsed.line, actualTotal);
      side = parsed.side;
      favored = "pickem"; // n/a for totals (mirrors gradeGame)
      homeAway = "home"; // n/a for totals; kept stable (mirrors gradeGame)
    }
    const conf = Number.isFinite(leg.rawConfidence) ? Math.max(0, Math.min(1, leg.rawConfidence)) : 0.5;
    res.rows.push({
      key: `${game.gameId}|${leg.market}`,
      season: game.season,
      phase: game.gameType,
      week: game.week,
      gameId: game.gameId,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      market: leg.market,
      selection: leg.selection,
      side,
      confidence: conf,
      result,
      oddsAmerican: leg.priceAmerican,
      pnlUnits: +pnl(result, leg.priceAmerican).toFixed(4),
      favored,
      homeAway,
      divGame: leg.divGame,
      dome: leg.dome,
      restAdvantage,
      wind: game.wind,
      temp: game.temp,
      gradedAt,
    });
  }
  return res;
}

function restAdv(side: Side, game: GameRow): number {
  const home = game.homeRest ?? 0;
  const away = game.awayRest ?? 0;
  return side === "home" ? home - away : away - home;
}

// ─── live-graded.jsonl I/O (same JSONL shape as picks-log.jsonl, separate file) ─

export function liveGradedLogPath(dir: string): string {
  return path.join(dir, "live-graded.jsonl");
}

export function loadLiveGradedRows(dir: string): GradedRow[] {
  const p = liveGradedLogPath(dir);
  if (!fs.existsSync(p)) return [];
  const out: GradedRow[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as GradedRow);
    } catch {
      // skip a corrupt line rather than crash the report
    }
  }
  return out;
}

/** Upsert by `key`; a re-run replaces a week's rows in place. */
export function upsertLiveGradedRows(dir: string, rows: GradedRow[]): { added: number; replaced: number } {
  fs.mkdirSync(dir, { recursive: true });
  const byKey = new Map<string, GradedRow>();
  for (const r of loadLiveGradedRows(dir)) byKey.set(r.key, r);
  let added = 0;
  let replaced = 0;
  for (const r of rows) {
    if (byKey.has(r.key)) replaced++;
    else added++;
    byKey.set(r.key, r);
  }
  const all = [...byKey.values()];
  fs.writeFileSync(liveGradedLogPath(dir), all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : ""));
  return { added, replaced };
}
