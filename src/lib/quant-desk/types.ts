// quant-desk/types.ts — the sport-agnostic vocabulary of THE QUANT DESK.
//
// Doctrine (Benter / Benham / Bloom): a PROPRIETARY MODEL makes fair
// probabilities; we bet ONLY where the market is mispriced vs the model; we
// size fractional-Kelly with a drawdown rail; we judge ourselves by CLOSING-LINE
// VALUE, not wins. Everything below is the deterministic engine's data shapes —
// no model logic lives here, only the contract the adapters and the loop share.
//
// Storage is JSON-backed (no DB, no migration), and ALL accounting is DERIVED
// from the bet rows so cash can never drift. This mirrors devig-paper.ts.

export type Sport = "MLB" | "NFL";

/** A single fair probability our model emits for one bettable outcome.
 *  The "fair-value bus": the adapter's only job upstream of the scanner is to
 *  fill this array honestly (and flag estimates as estimates). */
export interface FairValue {
  /** Stable key for the outcome — `${market}|${selection}` within a game. */
  key: string;
  market: string;        // "moneyline" | "total_over" | "prop:Strikeouts>=5" | …
  selection: string;     // human-readable ("Tampa Bay Rays ML", "Aranda TB 1+")
  /** OUR model's fair probability this outcome hits, in (0,1). */
  modelFairProb: number;
  /** Honesty flag — true when the fair value is a transparent estimate
   *  (e.g. an NFL Elo dry-run, or a synthesized prop series), not a tuned model. */
  estimate: boolean;
  /** Free-form note on how the fair value was produced (printed in reports). */
  basis: string;
}

/** A market line for the same outcome a FairValue describes, already de-vigged
 *  against its sharp reference, plus the best soft price we could actually take. */
export interface MarketLine {
  key: string;           // joins to FairValue.key
  /** De-vigged SHARP fair probability (Pinnacle, or nflverse ~closing line). */
  devigMarketProb: number;
  /** The price we would actually bet at (best soft for MLB; the ~closing line
   *  for the NFL dry-run). American odds. */
  priceAmerican: number;
  /** Which book the price came from ("pinnacle-close" for the NFL dry-run). */
  book: string;
  /** The sharp side's lean for direction-agreement: true when the SHARP market
   *  makes this the more-likely-than-not side (devigMarketProb > 0.5). */
  sharpFavorsThis: boolean;
}

/** One bettable opportunity = a FairValue joined to its MarketLine, with the
 *  edge computed. The scanner produces these; the sizer filters + stakes them. */
export interface Opportunity {
  sport: Sport;
  gameId: string;        // stable per-game id (for idempotency + correlation)
  matchup: string;       // "Away @ Home"
  commenceTime: string;  // ISO
  fair: FairValue;
  line: MarketLine;
  /** edge = modelFairProb − devigMarketProb. >0 = model thinks it's more likely
   *  than the de-vigged market does. */
  edge: number;
}

/** A staked paper bet. id makes opens idempotent across re-runs. Accounting is
 *  derived from these rows (status + pnl), never a running cash balance. */
export interface QuantBet {
  id: string;            // `${sport}|${gameId}|${fair.key}` — unique per outcome
  sport: Sport;
  gameId: string;
  matchup: string;
  market: string;
  selection: string;
  commenceTime: string;
  // entry (locked at open)
  entryAt: string;
  priceAmerican: number;       // the price we took
  book: string;
  modelFairProb: number;       // OUR model fair at entry
  devigMarketProb: number;     // sharp de-vigged fair at entry
  edge: number;                // modelFairProb − devigMarketProb at entry
  stakeUsd: number;
  estimate: boolean;           // carried from FairValue (dry-run honesty)
  /** The fair value's `basis` string, carried from FairValue at open time so the
   *  model's reasoning survives into the settled book (the public NFL Exp 5 card
   *  reads it). Optional: rows written before this field existed lack it. */
  basis?: string;
  // CLV tracking — the headline benchmark. Refreshed each tick until commence.
  closeAt: string;
  closeDevigMarketProb: number;     // latest sharp de-vigged fair (the "close")
  closeFairAmerican: number;        // American line implied by the close fair prob
  /** DEPRECATED — raw American subtraction; magnitude is invalid across ±100.
   *  Retained for book continuity. Read clvProbPoints. */
  clvCents: number | null;
  /** CLV in PROBABILITY POINTS (>0 = we took a longer price than the close). */
  clvProbPoints: number | null;
  beatClose: boolean | null;        // impliedProb(entry) < closeDevigMarketProb
  // settlement
  status: "open" | "won" | "lost" | "void";
  finalScore: string | null;
  pnlUsd: number | null;
  settledAt: string | null;
}

export interface LedgerSnapshot {
  ts: string;
  equityUsd: number;
  realizedPnlUsd: number;
  exposureUsd: number;
  openCount: number;
  settledCount: number;
  wins: number;
  losses: number;
  /** Drawdown from peak equity at this snapshot, as a fraction (0.05 = −5%). */
  drawdownPct: number;
}

export interface QuantBook {
  updatedAt: string;
  bets: QuantBet[];
  ledger: LedgerSnapshot[];
}

export function emptyBook(): QuantBook {
  return { updatedAt: "", bets: [], ledger: [] };
}
