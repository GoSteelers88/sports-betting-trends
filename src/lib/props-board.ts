/**
 * props-board.ts — player-prop +EV board: de-vigged Pinnacle prop lines
 * (the sharp reference) vs soft-book prop prices (The Odds API).
 *
 * Same philosophy as fair-value.ts for moneylines, applied to the SOFTEST
 * market the books offer. Measurement-only: this module prices and ranks;
 * it places nothing. Playable floor pre-registered at 3% EV (props carry
 * more vig than ML, so the 2% ML floor would be noise here); EV above 15%
 * is quarantined as suspicious (almost certainly a line/player mismatch).
 */
import { noVigFairProbTwoWay, expectedValue } from "@/lib/devig";

export const PROPS_PLAYABLE_FLOOR = 0.03;
export const PROPS_SUSPICIOUS_CEILING = 0.15;

/** The Odds API market key ↔ Pinnacle `units` for the props we price.
 *  Pinnacle units verified live 2026-06-10: TotalBases, EarnedRuns,
 *  Strikeouts, HomeRuns, PitchingOuts, HitsAllowed (MLB); Points, Rebounds,
 *  Assists, Threes Made (NBA). */
export const PROP_TYPE_MAP: Record<string, string> = {
  pitcher_strikeouts: "Strikeouts",
  batter_home_runs: "HomeRuns",
  batter_total_bases: "TotalBases",
  pitcher_earned_runs: "EarnedRuns",
  pitcher_hits_allowed: "HitsAllowed",
  pitcher_outs: "PitchingOuts",
  player_points: "Points", // NBA
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "Threes Made",
};

export interface SharpProp {
  player: string;
  units: string; // Pinnacle prop type ("Strikeouts", …)
  line: number;
  overAmerican: number;
  underAmerican: number;
  fairOverProb: number;
  cutoffAt: string;
}

export interface SoftPropQuote {
  player: string;
  market: string; // Odds API market key
  line: number;
  side: "Over" | "Under";
  american: number;
  book: string;
  commence: string;
}

/** "Brandon Sproat (Total Strikeouts)(must start)" → "Brandon Sproat" */
export function playerFromDescription(description: string): string {
  const i = description.indexOf("(");
  return (i > 0 ? description.slice(0, i) : description).trim();
}

/** Build a SharpProp from parsed Pinnacle pieces; null when devig fails. */
export function assembleSharpProp(input: {
  description: string;
  units: string;
  line: number;
  overAmerican: number;
  underAmerican: number;
  cutoffAt: string;
}): SharpProp | null {
  const devigged = noVigFairProbTwoWay(input.overAmerican, input.underAmerican);
  if (devigged == null) return null;
  return {
    player: playerFromDescription(input.description),
    units: input.units,
    line: input.line,
    overAmerican: input.overAmerican,
    underAmerican: input.underAmerican,
    fairOverProb: devigged.fairA,
    cutoffAt: input.cutoffAt,
  };
}

const normalize = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Same player? Exact normalized match, or last name + first initial. */
export function samePlayer(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(" ");
  const tb = nb.split(" ");
  return (
    ta.length > 1 &&
    tb.length > 1 &&
    ta[ta.length - 1] === tb[tb.length - 1] &&
    ta[0][0] === tb[0][0]
  );
}

export interface PropsBoardRow {
  player: string;
  propType: string; // Pinnacle units
  line: number;
  side: "Over" | "Under";
  book: string;
  softAmerican: number;
  fairProb: number; // fair prob of the QUOTED side
  evPct: number;
  suspicious: boolean;
  playable: boolean;
  sharpOverAmerican: number;
  sharpUnderAmerican: number;
  commence: string;
}

/**
 * Join soft quotes to sharp props (player + prop type + EXACT line) and
 * price every quoted side. Returns all matches, best EV first.
 */
export function buildPropsBoard(sharp: SharpProp[], soft: SoftPropQuote[]): PropsBoardRow[] {
  const rows: PropsBoardRow[] = [];
  for (const q of soft) {
    const units = PROP_TYPE_MAP[q.market];
    if (!units) continue;
    const match = sharp.find(
      (s) => s.units === units && s.line === q.line && samePlayer(s.player, q.player),
    );
    if (!match) continue;
    const fairProb = q.side === "Over" ? match.fairOverProb : 1 - match.fairOverProb;
    const ev = expectedValue(fairProb, q.american);
    if (ev == null || !Number.isFinite(ev)) continue;
    rows.push({
      player: match.player,
      propType: units,
      line: q.line,
      side: q.side,
      book: q.book,
      softAmerican: q.american,
      fairProb: +fairProb.toFixed(4),
      evPct: +(ev * 100).toFixed(2),
      suspicious: ev > PROPS_SUSPICIOUS_CEILING,
      playable: ev >= PROPS_PLAYABLE_FLOOR && ev <= PROPS_SUSPICIOUS_CEILING,
      sharpOverAmerican: match.overAmerican,
      sharpUnderAmerican: match.underAmerican,
      commence: q.commence,
    });
  }
  return rows.sort((a, b) => b.evPct - a.evPct);
}
