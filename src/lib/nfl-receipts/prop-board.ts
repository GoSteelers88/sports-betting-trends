// prop-board.ts — the PUBLIC weekly NFL prop-market receipt.
//
// The capture (nfl:props-week) writes under data/private/, which is gitignored,
// so nothing it produces can reach the built site. This is the committed public
// projection of it.
//
// 🚨 WHAT THIS IS: the best NUMBER available across US books per player/stat/
// side at capture time. It is the MARKET, not a pick list. No model chose these
// and no stake is implied — the same rule the board legs follow. Rendering it
// as "our props" would be a straight misrepresentation.
//
// Both sides of a player/stat are kept on purpose: best-over sits at the lowest
// number on offer and best-under at the highest, so they are NOT mirrors and
// both can win when the actual lands between them. That gap is what line
// shopping buys, and it is the thing worth measuring.

export type PropSide = "over" | "under";
export type PropOutcome = "win" | "loss" | "push" | "pending" | "no-data";

export interface PublicPropLine {
  gameId: string;
  matchup: string;
  player: string;
  team: string;
  stat: string;
  side: PropSide;
  point: number;
  priceAmerican: number;
  book: string;
  booksOffering: number;
  result: PropOutcome;
  actualValue: number | null;
}

/** A model pick against one of the posted lines. Mirrors LivePropPick in
 *  nfl-live-props-pick.ts; duplicated as a plain shape so the page type does
 *  not depend on the script-side module. */
export interface PublicPropPick {
  gameId: string;
  matchup: string;
  player: string;
  team: string;
  stat: string;
  side: PropSide;
  point: number;
  priceAmerican: number;
  book: string;
  confidence: number;
  impliedProb: number;
  edge: number;
  rationale: string;
  verdict: "play" | "pass";
  passReason: string | null;
  result?: PropOutcome;
  actualValue?: number | null;
}

export interface PublicPropBoard {
  season: number;
  week: number;
  capturedAt: string;
  gradedAt: string | null;
  games: number;
  lines: PublicPropLine[];
  byStat: Array<{ stat: string; n: number; wins: number; losses: number; pushes: number; hitRatePct: number | null }>;
  totals: { lines: number; settled: number; pending: number; wins: number; losses: number; hitRatePct: number | null };
  /** Model picks against those lines. Absent until nfl:props-picks has run. */
  picks?: PublicPropPick[];
  picksGeneratedAt?: string;
  pickFloors?: { confidence: number; edge: number };
}

export function summarizeProps(lines: PublicPropLine[]): {
  byStat: PublicPropBoard["byStat"];
  totals: PublicPropBoard["totals"];
} {
  const groups = new Map<string, PublicPropLine[]>();
  for (const l of lines) {
    const a = groups.get(l.stat) ?? [];
    a.push(l);
    groups.set(l.stat, a);
  }
  const tally = (rows: PublicPropLine[]) => {
    let wins = 0, losses = 0, pushes = 0;
    for (const r of rows) {
      if (r.result === "win") wins++;
      else if (r.result === "loss") losses++;
      else if (r.result === "push") pushes++;
    }
    const dec = wins + losses;
    // Hit rate over DECISIVE lines only — pushes and ungraded rows in the
    // denominator would drag every figure toward zero and read as a loss.
    return { wins, losses, pushes, hitRatePct: dec === 0 ? null : Math.round((wins / dec) * 1000) / 10 };
  };
  const byStat = [...groups]
    .map(([stat, rows]) => ({ stat, n: rows.length, ...tally(rows) }))
    .sort((a, b) => b.n - a.n);
  const t = tally(lines);
  const settled = t.wins + t.losses + t.pushes;
  return {
    byStat,
    totals: {
      lines: lines.length,
      settled,
      pending: lines.length - settled,
      wins: t.wins,
      losses: t.losses,
      hitRatePct: t.hitRatePct,
    },
  };
}

/** Group lines by game for display — the page renders one collapsed block per
 *  game rather than 476 rows in a single wall. */
export function propsByGame(lines: PublicPropLine[]): Array<{ gameId: string; matchup: string; lines: PublicPropLine[] }> {
  const m = new Map<string, { gameId: string; matchup: string; lines: PublicPropLine[] }>();
  for (const l of lines) {
    const g = m.get(l.gameId) ?? { gameId: l.gameId, matchup: l.matchup, lines: [] };
    g.lines.push(l);
    m.set(l.gameId, g);
  }
  return [...m.values()].sort((a, b) => a.gameId.localeCompare(b.gameId));
}
