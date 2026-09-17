// play-record.ts — the PUBLIC settled record of published NFL PLAY legs.
//
// Why this file exists: the site is built from committed data, but the graded
// source (live-graded.jsonl) and the results (games.csv) both live under
// data/private/ and are gitignored. So the homepage could show three live NFL
// plays and, directly beneath, an all-time table with NO NFL row at all —
// which is exactly what a reader noticed. This is the one committed artifact
// that carries how the published plays actually settled.
//
// It deliberately carries PLAY legs only. Passes and controls are reads, not
// positions; publishing their W/L next to a record would inflate the sample
// with rows nobody could have bet.
//
// 🚨 This is NOT the paper trial. Those picks are Kelly-staked with a real ROI
// denominator; these are flat 1u doctrine plays off a pre-registered board.
// Anything rendering both MUST keep them visibly separate — same trap as
// putting two experiments under one "Before/Now" column.

export type PlayResult = "win" | "loss" | "push" | "pending";

export interface PlayRecordLeg {
  season: number;
  week: number;
  legId: string;
  gameId: string;
  matchup: string;
  market: string;
  selection: string;
  entryPriceAmerican: number | null;
  result: PlayResult;
  /** Profit in units at a flat 1u stake. Null while pending. */
  pnlUnits: number | null;
}

export interface PlayRecord {
  generatedAt: string;
  /** Flat stake per leg, in units — stated so no reader infers Kelly sizing. */
  stakePerLegUnits: 1;
  legs: PlayRecordLeg[];
  totals: {
    published: number;
    settled: number;
    pending: number;
    wins: number;
    losses: number;
    pushes: number;
    unitsPnl: number;
    /** Win rate over DECISIVE legs only; null under 1 decisive leg. */
    winRatePct: number | null;
  };
}

export function summarizePlayRecord(legs: PlayRecordLeg[]): PlayRecord["totals"] {
  let wins = 0, losses = 0, pushes = 0, pending = 0, unitsPnl = 0;
  for (const l of legs) {
    if (l.result === "win") { wins++; unitsPnl += l.pnlUnits ?? 0; }
    else if (l.result === "loss") { losses++; unitsPnl += l.pnlUnits ?? -1; }
    else if (l.result === "push") pushes++;
    else pending++;
  }
  const decisive = wins + losses;
  return {
    published: legs.length,
    settled: wins + losses + pushes,
    pending,
    wins,
    losses,
    pushes,
    unitsPnl: Math.round(unitsPnl * 1000) / 1000,
    winRatePct: decisive === 0 ? null : Math.round((wins / decisive) * 1000) / 10,
  };
}

/** Compact label for a table cell: "1-1 · 3 pend" (pushes shown only if any). */
export function playRecordLabel(t: PlayRecord["totals"]): string {
  const parts = [`${t.wins}-${t.losses}`];
  if (t.pushes) parts.push(`${t.pushes} push`);
  if (t.pending) parts.push(`${t.pending} pend`);
  return parts.join(" · ");
}
