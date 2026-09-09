// data.ts — the ONLY place the receipts chat touches the filesystem.
//
// Every source here is committed JSON that some other, already-audited pipeline
// wrote (the publisher, the CLV grader, the Pinnacle scrape, the injury wire,
// the offline backtest summariser). This module reads it and nothing else: no
// writes, no network, no DB. It is the imperative shell; board-index.ts,
// validators.ts and the projections in tools.ts are the pure core.
//
// FAILURE POLICY (Armstrong): a missing or malformed file is a NORMAL case, not
// an exception. Every loader degrades to an explicit absence — `null`, `[]`, or
// an `{available:false, reason}` envelope the model can read and speak to — and
// logs once. Nothing here throws into a request handler, because "the desk
// couldn't read its own ledger" is an answer, and a 500 is not.

import fs from "node:fs";
import path from "node:path";
import type { PublishedBoard } from "@/lib/nfl-receipts/board";
import type { Ledger } from "@/lib/nfl-receipts/ledger";
import type { NflSlate } from "@/lib/nfl-receipts/site-slate";

export function processedDir(root = process.cwd()): string {
  return path.join(root, "data", "processed");
}
export function nflLiveDir(root = process.cwd()): string {
  return path.join(processedDir(root), "nfl-live");
}

function readJson<T>(file: string, what: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    console.error(`[chat/nfl] unreadable ${what} (${path.basename(file)}):`, err);
    return null;
  }
}

// ─── Published boards ────────────────────────────────────────────────────────

export interface LoadedBoard {
  board: PublishedBoard;
  file: string;
}

/** Every published board file, oldest week first. A board that fails to parse
 *  is SKIPPED and logged — one corrupt receipt must not hide the others. */
export function loadPublishedBoards(root = process.cwd()): LoadedBoard[] {
  const dir = nflLiveDir(root);
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /^board-\d{4}-wk\d{2}\.json$/.test(n))
      .sort();
  } catch (err) {
    console.error("[chat/nfl] cannot list published boards:", err);
    return [];
  }
  const out: LoadedBoard[] = [];
  for (const name of names) {
    const board = readJson<PublishedBoard>(path.join(dir, name), "board");
    if (!board || !Array.isArray(board.legs)) continue;
    out.push({ board, file: name });
  }
  out.sort((a, b) => a.board.season - b.board.season || a.board.week - b.board.week);
  return out;
}

export function loadLedger(root = process.cwd()): Ledger | null {
  const l = readJson<Ledger>(path.join(nflLiveDir(root), "ledger.json"), "ledger");
  if (!l || !Array.isArray(l.rows) || !Array.isArray(l.boards)) return null;
  return l;
}

export function loadSlate(root = process.cwd()): NflSlate | null {
  const s = readJson<NflSlate>(path.join(processedDir(root), "nfl-slate.json"), "slate");
  if (!s || !Array.isArray(s.games)) return null;
  return s;
}

// ─── Research summary (nfl-exp5.json) ────────────────────────────────────────

export interface Exp5Raw {
  generatedAt?: string;
  record?: { wins?: number; losses?: number; pushes?: number };
  settled?: number;
  clvBeatRatePct?: number;
  avgClvProbPoints?: number;
  roiPct?: number;
  note?: string;
  props?: {
    record?: { wins?: number; losses?: number; pushes?: number };
    settled?: number;
    noData?: number;
  };
  parlays?: {
    record?: { wins?: number; losses?: number; pushes?: number };
    settled?: number;
    roiPct?: number;
    winRatePct?: number;
    breakEvenPct?: number;
    avgLegsEdge?: number;
    note?: string;
  };
}

export function loadExp5(root = process.cwd()): Exp5Raw | null {
  return readJson<Exp5Raw>(path.join(processedDir(root), "nfl-exp5.json"), "exp5");
}

// ─── Injury wire ─────────────────────────────────────────────────────────────

export interface InjuryRow {
  player: string;
  team: string;
  position?: string;
  status?: string;
  injuryType?: string;
  returnDate?: string;
}
export interface InjuryFile {
  fetchedAt?: string;
  sport?: string;
  players?: InjuryRow[];
}

export function loadInjuries(root = process.cwd()): InjuryFile | null {
  const f = readJson<InjuryFile>(
    path.join(processedDir(root), "injuries-nfl.json"),
    "injuries"
  );
  if (!f || !Array.isArray(f.players)) return null;
  return f;
}

// ─── Standings (SEASON-GATED — see standingsSeasonGate) ──────────────────────

export interface StandingsRow {
  team: string;
  abbreviation?: string;
  wins: number;
  losses: number;
  winPct?: number;
  homeRecord?: string;
  awayRecord?: string;
  pointDiff?: number;
  streak?: string;
  conference?: string;
}

export function loadStandings(root = process.cwd()): StandingsRow[] | null {
  const s = readJson<StandingsRow[]>(
    path.join(processedDir(root), "standings-nfl.json"),
    "standings"
  );
  return Array.isArray(s) ? s : null;
}

/** Is the standings file the CURRENT season's?
 *
 *  The file is a bare 32-row array with no season field, so the season is
 *  derived from its CONTENT, not from its mtime: a git checkout and every
 *  Vercel build rewrite mtimes, so an mtime gate would fail OPEN in production
 *  and publish last season's final table as if it were live.
 *
 *  Content rule: a team cannot have played more games than weeks have been
 *  played. `currentWeek` is the latest PUBLISHED board week (the one thing on
 *  disk that dates itself). The +1 is slack for a table captured after the
 *  week's late games. On 2026-09-09 the committed file says the Patriots are
 *  14-3 — 17 games against a week-1 board — so it gates out, which is correct:
 *  those are the FINAL 2025 standings. */
export function standingsSeasonGate(
  rows: StandingsRow[] | null,
  currentWeek: number | null
): { current: true } | { current: false; reason: string } {
  if (!rows || rows.length === 0) return { current: false, reason: "no standings file on disk" };
  let maxPlayed = 0;
  for (const r of rows) {
    const played = (Number(r.wins) || 0) + (Number(r.losses) || 0);
    if (played > maxPlayed) maxPlayed = played;
  }
  if (currentWeek == null) {
    // No published board to date the season against. A completed 17-game
    // regular season is unambiguously not "this week's" table.
    return maxPlayed >= 17
      ? { current: false, reason: `standings show ${maxPlayed} games played — a completed season` }
      : { current: true };
  }
  if (maxPlayed > currentWeek + 1) {
    return {
      current: false,
      reason: `standings show up to ${maxPlayed} games played but only week ${currentWeek} is published — this is a PRIOR season's table`,
    };
  }
  return { current: true };
}
