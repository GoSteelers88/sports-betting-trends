// board.ts — the public, immutable receipt: what was published, at what real
// price, before which kickoff. Written once by scripts/nfl-publish-board.ts to
// data/processed/nfl-live/board-YYYY-wkNN.json (repo-committed; the git SHA +
// the SHA256 recorded in ledger.json are the notary). Boards are NEVER edited
// after publish — corrections go to the ledger's errata array.

export type BoardMarket = "moneyline" | "ats" | "total";
export type LegSide = "home" | "away" | "over" | "under";
export type LegRole = "play" | "pass" | "control";

/** Where an entry price actually came from — no price on the board exists
 *  without one of these attached (threat T10: the old live board printed
 *  hardcoded -110s nobody offered). */
export interface PriceProvenance {
  book: string; // bookmaker key as the Odds API reports it
  snapshotFile: string; // the committed entry snapshot this was read from
  snapshotFetchedAt: string; // ISO time the snapshot was fetched
  oddsApiEventId: string; // recorded for audit, never used for identity
}

export interface PublishedLeg {
  legId: string;
  role: LegRole;
  /** control legs carry the legId of the PLAY leg they placebo (threat T9);
   *  play legs with a control carry the control's legId. */
  pairId?: string;
  gameId: string; // nflverse-style id when known, else `${date}_${AWAY}_${HOME}`
  matchup: string; // "AWAY @ HOME"
  kickoffUtc: string; // required — the 12h gate is unenforceable without it
  market: BoardMarket;
  selection: string;
  side: LegSide;
  point: number | null; // spread/total line; null for moneyline
  /** Real price from the entry snapshot, or null = published but permanently
   *  excluded from the CLV ledger (never backfilled — season-plan ruling). */
  entryPriceAmerican: number | null;
  /** The other side's price at the same instant — devig needs both. */
  entryOtherSideAmerican: number | null;
  priceProvenance: PriceProvenance | null;
  clvEligible: boolean; // entry price + other side both present
  verdict: "PLAY" | "PASS" | "CONTROL";
  passReason?: string;
  // Model fields carried through from the private doctrine board:
  rawConfidence?: number;
  haircutConfidence?: number;
  calibratedConfidence?: number;
  stakeFraction?: number;
  edge?: number | null;
  evPct?: number | null;
  doctrineNotes?: string[];
}

export interface DroppedLeg {
  gameId: string;
  matchup: string;
  market: BoardMarket;
  selection: string;
  reason: "inside_12h_window" | "no_kickoff_time" | "kickoff_passed";
  kickoffUtc: string | null;
}

export interface PublishedBoard {
  schemaVersion: 1;
  season: number;
  week: number;
  publishedAt: string;
  /** Committed raw Odds API snapshot every price on this board came from. */
  entrySnapshotFile: string;
  entrySnapshotFetchedAt: string;
  /** Odds API x-requests-used at the publish snapshot — pins how many paid
   *  pulls preceded the one that became the board, so entry-price re-rolling
   *  ("fetch until the prices look good") leaves a visible counter. */
  oddsApiQuotaUsedAtPublish: string;
  /** Basename of the private model board this was priced from (audit only —
   *  the private file itself never publishes). */
  modelBoardSource: string;
  legs: PublishedLeg[];
  dropped: DroppedLeg[];
  /** Printed only when ≥3 ML PLAY legs survive doctrine; paper-only. */
  parlay: {
    legIds: string[];
    combinedProb: number;
    combinedDecimal: number;
    evPct: number;
  } | null;
  note: string;
}

export function boardFileName(season: number, week: number): string {
  return `board-${season}-wk${String(week).padStart(2, "0")}.json`;
}

/** Publish-time gate (threat T11): a leg publishes only with a kickoff that
 *  is ≥12h away. Legs are DROPPED, the board is never delayed — ruling 5. */
export function kickoffGate(
  kickoffUtc: string | null,
  nowMs: number,
): DroppedLeg["reason"] | null {
  if (!kickoffUtc || !Number.isFinite(Date.parse(kickoffUtc)))
    return "no_kickoff_time";
  const t = Date.parse(kickoffUtc);
  if (t <= nowMs) return "kickoff_passed";
  if (t - nowMs < 12 * 3600_000) return "inside_12h_window";
  return null;
}
