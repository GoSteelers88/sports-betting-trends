// board-index.ts — the pure, in-memory index of every PUBLISHED NFL board leg.
//
// This is the frozen anchor the receipts desk is judged against. Everything the
// chat may assert about an NFL selection has to resolve to a row in here, and
// the rows come from immutable committed JSON
// (data/processed/nfl-live/board-YYYY-wkNN.json) — never from the model, never
// from a web search, never from user text.
//
// Pure over its input: takes already-loaded PublishedBoard objects and returns
// an index. No I/O, so it unit-tests against a fixture and against the real
// committed board identically.

import type { PublishedBoard, PublishedLeg } from "@/lib/nfl-receipts/board";
import { franchiseKey } from "@/lib/nfl-receipts/teams";

export type BoardMarketKind = "moneyline" | "ats" | "total";

/** One published leg, flattened with the franchise keys resolved. This is the
 *  shape the validator matches a reply's assertions against. */
export interface BoardLegRef {
  legId: string;
  season: number;
  week: number;
  boardFile: string;
  publishedAt: string;
  role: "play" | "pass" | "control";
  verdict: "PLAY" | "PASS" | "CONTROL";
  gameId: string;
  matchup: string;
  kickoffUtc: string;
  market: BoardMarketKind;
  selection: string;
  side: string;
  point: number | null;
  /** Canonical franchise key the SELECTION names ("jets"), or null for a
   *  total (OVER 47.5 names no team). */
  selectionFranchise: string | null;
  /** Both franchises in the game, from the "AWAY @ HOME" matchup string. */
  awayFranchise: string | null;
  homeFranchise: string | null;
  passReason?: string;
}

export interface PublishedWeekRef {
  season: number;
  week: number;
  publishedAt: string;
  boardFile: string;
}

/** A line the CURRENT market is hanging. Not a board row and not a desk
 *  opinion — but a real, quotable number, and the desk is expected to read it
 *  out ("the market has Tennessee -1, total 39"). */
export interface MarketLineRef {
  awayFranchise: string | null;
  homeFranchise: string | null;
  spreadPoint: number | null;
  totalPoint: number | null;
}

export interface BoardIndex {
  legs: BoardLegRef[];
  weeks: PublishedWeekRef[];
  /** Current market lines, so a truthful market quote is not mistaken for a
   *  fabricated board selection. See the R1 rule in validators.ts: the desk was
   *  blocked for saying "Titans -1" — the real current spread — because -1 is
   *  not the point the BOARD recorded at entry. Market numbers move; that is
   *  what a market is. Quoting one is reporting, and the recommend tier still
   *  governs whether the desk is telling anyone to take it. */
  marketLines: MarketLineRef[];
  /** franchise key → every leg whose SELECTION names that franchise. */
  bySelectionFranchise: Map<string, BoardLegRef[]>;
  /** franchise key → every leg on a game that franchise appears in (either
   *  side of the matchup). A "we passed on Buffalo" report is legitimate even
   *  when the pass leg's selection names the opponent. */
  byGameFranchise: Map<string, BoardLegRef[]>;
  /** The PLAY-role legs only — the entire set of things this desk has ever
   *  told anyone to bet on the NFL. */
  plays: BoardLegRef[];
}

/** "NYJ @ TEN" → { away: "jets", home: "titans" }. Unparseable → nulls; a
 *  join failure surfaces as null, never as a fuzzy guess (teams.ts rule). */
export function parseMatchup(matchup: string): {
  away: string | null;
  home: string | null;
} {
  const parts = matchup.split("@");
  if (parts.length !== 2) return { away: null, home: null };
  return {
    away: franchiseKey(parts[0]!.trim()),
    home: franchiseKey(parts[1]!.trim()),
  };
}

/** The franchise a selection string names: "NYJ ML" → "jets", "ARI +10" →
 *  "cardinals", "OVER 47.5" → null (a total names no team). */
export function selectionFranchise(selection: string): string | null {
  const first = selection.trim().split(/\s+/)[0];
  if (!first) return null;
  const upper = first.toUpperCase();
  if (upper === "OVER" || upper === "UNDER") return null;
  return franchiseKey(first);
}

function legRef(
  board: PublishedBoard,
  boardFile: string,
  leg: PublishedLeg
): BoardLegRef {
  const { away, home } = parseMatchup(leg.matchup);
  return {
    legId: leg.legId,
    season: board.season,
    week: board.week,
    boardFile,
    publishedAt: board.publishedAt,
    role: leg.role,
    verdict: leg.verdict,
    gameId: leg.gameId,
    matchup: leg.matchup,
    kickoffUtc: leg.kickoffUtc,
    market: leg.market,
    selection: leg.selection,
    side: leg.side,
    point: leg.point,
    selectionFranchise: selectionFranchise(leg.selection),
    awayFranchise: away,
    homeFranchise: home,
    ...(leg.passReason ? { passReason: leg.passReason } : {}),
  };
}

function push(map: Map<string, BoardLegRef[]>, key: string, ref: BoardLegRef) {
  const cur = map.get(key);
  if (cur) cur.push(ref);
  else map.set(key, [ref]);
}

export function buildBoardIndex(
  boards: Array<{ board: PublishedBoard; file: string }>,
  marketLines: MarketLineRef[] = []
): BoardIndex {
  const legs: BoardLegRef[] = [];
  const weeks: PublishedWeekRef[] = [];
  const bySelectionFranchise = new Map<string, BoardLegRef[]>();
  const byGameFranchise = new Map<string, BoardLegRef[]>();

  for (const { board, file } of boards) {
    weeks.push({
      season: board.season,
      week: board.week,
      publishedAt: board.publishedAt,
      boardFile: file,
    });
    for (const leg of board.legs) {
      const ref = legRef(board, file, leg);
      legs.push(ref);
      if (ref.selectionFranchise) push(bySelectionFranchise, ref.selectionFranchise, ref);
      if (ref.awayFranchise) push(byGameFranchise, ref.awayFranchise, ref);
      if (ref.homeFranchise && ref.homeFranchise !== ref.awayFranchise) {
        push(byGameFranchise, ref.homeFranchise, ref);
      }
    }
  }

  weeks.sort((a, b) => a.season - b.season || a.week - b.week);

  return {
    legs,
    weeks,
    marketLines,
    bySelectionFranchise,
    byGameFranchise,
    plays: legs.filter((l) => l.role === "play"),
  };
}

export const EMPTY_BOARD_INDEX: BoardIndex = {
  legs: [],
  weeks: [],
  marketLines: [],
  bySelectionFranchise: new Map(),
  byGameFranchise: new Map(),
  plays: [],
};
