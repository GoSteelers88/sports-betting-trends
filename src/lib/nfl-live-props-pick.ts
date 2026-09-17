// nfl-live-props-pick.ts — pick against REAL posted prop lines.
//
// WHY THIS IS NOT THE BACKTEST PROP PATH. makeClaudePropsPickFn hardcodes
// PROP_THRESHOLDS (passYds 250, rushYds 75, recYds 50) and instructs the model
// to "echo the standard threshold". Every one of the 343 rows in the 2025
// holdout therefore sat on a whole number no book posts, with no price
// attached. Measured 2026-09-17: against the control of simply backing the same
// player at the same number every week, that model added +1.7pp overall and
// +0.4pp on receiving yards — its largest sample. It was naming good players,
// not finding edges.
//
// This path gives the model the actual half-point lines and the actual prices,
// so a pick is tradeable and its value is arithmetic rather than vibes.
//
// 🚨 UNTESTED OUT OF SAMPLE. Picking among posted lines is a different task from
// what the holdout refuted, so that result does not directly condemn it — but
// nothing has validated it either. Anything published from this must carry no
// stake and be graded in public.

import type { PropStat } from "./nfl-loop";

/** One player/stat with the best number available on each side. */
export interface LineCandidate {
  gameId: string;
  matchup: string;
  player: string;
  team: string;
  stat: PropStat;
  over: { point: number; priceAmerican: number; book: string } | null;
  under: { point: number; priceAmerican: number; book: string } | null;
}

export interface LivePropPick {
  gameId: string;
  matchup: string;
  player: string;
  team: string;
  stat: PropStat;
  side: "over" | "under";
  point: number;
  priceAmerican: number;
  book: string;
  /** The model's probability that this side hits. */
  confidence: number;
  /** What the offered price implies, vig included. */
  impliedProb: number;
  /** confidence − impliedProb. Positive = the model thinks the price is wrong. */
  edge: number;
  rationale: string;
  verdict: "play" | "pass";
  passReason: string | null;
}

/** American odds → implied probability, vig included.
 *  Using the VIGGED number is deliberate: for a single-side bet EV is positive
 *  exactly when true probability exceeds the offered price's implied
 *  probability. De-vigging would need both sides at the same number from the
 *  same book, which a best-line capture does not have — and would only ever
 *  LOWER the bar. Conservative by construction. */
export function impliedProb(american: number): number {
  return american >= 0 ? 100 / (american + 100) : -american / (-american + 100);
}

/** ⚠️ NOT the doctrine's 62%. That figure was derived from the backtest path,
 *  where the model picked SOFT ROUND NUMBERS (a receiver over 50 yards) — a
 *  bar 62% confidence clears often. Real posted lines are half-points set near
 *  the player's median, so they are priced close to a coin flip. Measured
 *  2026-09-17 against 232 real week-2 lines: the model returned 14 views, every
 *  one between 56% and 60%, and ALL FOURTEEN died on a 62% floor — while every
 *  one had POSITIVE edge over its price. A floor carried across from a
 *  different task is not a safety measure, it is just an off switch.
 *
 *  55% keeps the requirement that a view actually favours a side, and lets the
 *  EDGE floor below do the economic work: for a single-side bet EV is positive
 *  exactly when the true probability beats the offered price's implied
 *  probability. There is still NO calibration map for props, so this confidence
 *  is unvalidated — which is why anything published from it carries no stake. */
export const CONFIDENCE_FLOOR = 0.55;
/** Edge over the offered price. 5pp, well clear of a half-point of juice. */
export const EDGE_FLOOR = 0.05;

export function gatePick(
  p: Omit<LivePropPick, "verdict" | "passReason">,
  confidenceFloor = CONFIDENCE_FLOOR,
  edgeFloor = EDGE_FLOOR,
): LivePropPick {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  if (!Number.isFinite(p.confidence) || p.confidence < confidenceFloor) {
    return { ...p, verdict: "pass", passReason: `confidence ${pct(p.confidence)} < floor ${pct(confidenceFloor)}` };
  }
  if (p.edge < edgeFloor) {
    return { ...p, verdict: "pass", passReason: `edge ${pct(p.edge)} < floor ${pct(edgeFloor)} vs the price on offer` };
  }
  return { ...p, verdict: "play", passReason: null };
}

/** Build a pick from a model view + the line it was taken against. Returns null
 *  when the model names a side the market does not actually offer — a view with
 *  no tradeable line is not a pick. */
export function buildPick(
  c: LineCandidate,
  side: "over" | "under",
  confidence: number,
  rationale: string,
): LivePropPick | null {
  const quote = side === "over" ? c.over : c.under;
  if (!quote) return null;
  const implied = impliedProb(quote.priceAmerican);
  return gatePick({
    gameId: c.gameId,
    matchup: c.matchup,
    player: c.player,
    team: c.team,
    stat: c.stat,
    side,
    point: quote.point,
    priceAmerican: quote.priceAmerican,
    book: quote.book,
    confidence,
    impliedProb: implied,
    edge: confidence - implied,
    rationale: rationale.slice(0, 200),
  });
}

/** Collapse captured lines into one candidate per player/stat, carrying the best
 *  number on each side. */
export function toCandidates(
  lines: Array<{
    gameId: string; matchup: string; player: string; team: string;
    stat: string; side: string; point: number; priceAmerican: number; book: string;
  }>,
): LineCandidate[] {
  const m = new Map<string, LineCandidate>();
  for (const l of lines) {
    if (!l.team) continue; // no team → cannot be graded, so never offer it
    const k = `${l.gameId}|${l.player}|${l.stat}`;
    const c = m.get(k) ?? {
      gameId: l.gameId, matchup: l.matchup, player: l.player, team: l.team,
      stat: l.stat as PropStat, over: null, under: null,
    };
    const q = { point: l.point, priceAmerican: l.priceAmerican, book: l.book };
    if (l.side === "over") c.over = q;
    else if (l.side === "under") c.under = q;
    m.set(k, c);
  }
  return [...m.values()].sort((a, b) => a.gameId.localeCompare(b.gameId) || a.player.localeCompare(b.player));
}
