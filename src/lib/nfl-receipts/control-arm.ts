// control-arm.ts — the pre-registered placebo arm (threat T9), FROZEN
// 2026-08-29, before the first published board.
//
// Why it exists: an early-week entry beats the Sunday close for structural
// reasons that have nothing to do with the model — this repo's own clv-proof
// experiment measures exactly that timing edge, with no model in it. A naked
// "PLAY legs beat the close 58%" number would therefore present market
// structure as model skill — over a NEGATIVE holdout. The verdict metric is
// PLAY beat rate MINUS control beat rate over paired graded legs.
//
// THE FROZEN RULE (changing it after any board publishes voids the season):
//   For each PLAY leg, the control leg is drawn from the SAME entry snapshot
//   at the SAME instant:
//     1. Candidate pool: every game on the slate with a two-sided price for
//        the same market in the entry snapshot, EXCLUDING every game that
//        carries any PLAY leg, ordered by gameId ascending.
//     2. Candidate index = parseInt(first 8 hex of sha256(playLegId), 16)
//        mod poolSize.
//     3. Side: 9th hex char of the same hash — even nibble → home/over,
//        odd nibble → away/under.
//     4. Price and line: the market's main line for that side in the entry
//        snapshot. No price → the control leg publishes clvEligible=false
//        exactly like a play leg would.
//   Control legs pass the same 12h kickoff gate; a control whose game is
//   gated is re-drawn from the remaining pool in hash order (deterministic:
//   next index = (index + 1) mod poolSize until exhausted).
//   Empty pool → the PLAY leg publishes with no pair; the paired metric
//   simply has one fewer pair (visible, since pairedN is printed).
//
// The hash makes selection deterministic given (boardFile, leg identity) and
// unriggable-in-hindsight: the placebo is fixed the moment the play leg's
// identity exists, before anyone sees prices move.

import { sha256Hex } from "./leg-id";
import type { BoardMarket, LegSide } from "./board";

export interface ControlCandidate {
  gameId: string;
  matchup: string;
  kickoffUtc: string;
  /** true when the game passes the publish-time kickoff gate */
  publishable: boolean;
  /** prices for this market, by side, from the entry snapshot */
  prices: Partial<
    Record<LegSide, { american: number; otherAmerican: number; point: number | null; book: string; oddsApiEventId: string }>
  >;
}

export interface ControlDraw {
  gameId: string;
  matchup: string;
  kickoffUtc: string;
  side: LegSide;
  point: number | null;
  american: number | null;
  otherAmerican: number | null;
  book: string | null;
  oddsApiEventId: string | null;
}

/** Deterministically draw the control leg for one PLAY leg.
 *  `pool` must already exclude games carrying any PLAY leg and be the full
 *  slate otherwise; ordering is enforced here. Returns null on empty pool. */
export function drawControl(
  playLegId: string,
  market: BoardMarket,
  pool: ControlCandidate[],
): ControlDraw | null {
  const ordered = [...pool].sort((a, b) => a.gameId.localeCompare(b.gameId));
  if (ordered.length === 0) return null;
  const h = sha256Hex(playLegId);
  const start = parseInt(h.slice(0, 8), 16) % ordered.length;
  const sideNibble = parseInt(h[8], 16);
  const wantFirst = sideNibble % 2 === 0; // home/over : away/under
  const side: LegSide =
    market === "total" ? (wantFirst ? "over" : "under") : wantFirst ? "home" : "away";

  for (let step = 0; step < ordered.length; step++) {
    const cand = ordered[(start + step) % ordered.length];
    if (!cand.publishable) continue;
    const price = cand.prices[side];
    return {
      gameId: cand.gameId,
      matchup: cand.matchup,
      kickoffUtc: cand.kickoffUtc,
      side,
      point: price?.point ?? null,
      american: price?.american ?? null,
      otherAmerican: price?.otherAmerican ?? null,
      book: price?.book ?? null,
      oddsApiEventId: price?.oddsApiEventId ?? null,
    };
  }
  return null; // every candidate gated
}
