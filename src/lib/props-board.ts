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
import fs from "node:fs";
import path from "node:path";
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
  // Game identity — threaded through from the Odds API `/events` row so the
  // parlay assembler can prove two legs come from DIFFERENT, independent games.
  // Without this the parlay strategy is unverifiable (legs from the same game
  // are correlated). A row missing `gameId` is INELIGIBLE for parlays.
  gameId: string;
  team?: string; // the player's team (Odds API home/away_team, resolved later if available)
  opponent?: string;
}

/**
 * "Brandon Sproat (Total Strikeouts)(must start)" → "Brandon Sproat"
 * "Aaliyah Edwards Total Rebounds" → "Aaliyah Edwards"
 *
 * Pinnacle MLB player-prop specials parenthesize the stat; WNBA/NBA specials
 * append it bare ("<Player> Total <Stat>"). Strip both so the player name joins
 * the clean Odds API name.
 */
export function playerFromDescription(description: string): string {
  const paren = description.indexOf("(");
  let s = paren > 0 ? description.slice(0, paren) : description;
  const total = s.search(/\sTotal\s/i);
  if (total > 0) s = s.slice(0, total);
  return s.trim();
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

/**
 * Same player? Exact normalized match, or an ABBREVIATED form vs the full name
 * ("B. Sproat" ≈ "Brandon Sproat").
 *
 * The initial-only fallback fires ONLY when at least one side's first token is a
 * single letter (a genuine abbreviation). Two FULL first names that merely share
 * a last name + first initial are DIFFERENT people — this is the collision that
 * matters in MLB, where "Jose Ramirez" and "Jeremy Ramirez" (or two J. Garcías)
 * would otherwise be fused and a sharp prop priced onto the wrong player's soft
 * line. We require the same last name AND same first initial AND that the names
 * are abbreviation-compatible (the full first name starts with the initial), so
 * "J. Ramirez" ≈ "Jose Ramirez" but "Jose Ramirez" ≠ "Jeremy Ramirez".
 */
export function samePlayer(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(" ");
  const tb = nb.split(" ");
  if (ta.length < 2 || tb.length < 2) return false;
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false; // different last name
  if (ta[0][0] !== tb[0][0]) return false; // different first initial
  const aAbbrev = ta[0].length === 1; // "b" from "B. Sproat"
  const bAbbrev = tb[0].length === 1;
  // At least one side must be an abbreviation for the initial match to be
  // trustworthy. Two full first names sharing only an initial are NOT a match.
  if (!aAbbrev && !bAbbrev) return false;
  // The abbreviated side's initial must be the prefix of the full side's first
  // name (it already is, since first initials are equal) — guaranteed above.
  return true;
}

export interface PropsBoardRow {
  league: string; // "MLB" | "WNBA" | "NBA" — the slate this prop came from
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
  // Home-run highlight — set true when an MLB HR (HomeRuns/Over) prop's
  // de-vigged fair prob beats the soft book's implied prob by the playable
  // floor. A surfacing flag only (🔥 in the print); NOT a staked sub-experiment.
  hrLike: boolean;
  sharpOverAmerican: number;
  sharpUnderAmerican: number;
  commence: string;
  // Game identity (see SoftPropQuote). Threaded so the parlay assembler can
  // require three DISTINCT games. Possibly "" if the soft quote lacked it.
  gameId: string;
  team?: string;
  opponent?: string;
}

/**
 * Join soft quotes to sharp props (player + prop type + EXACT line) and
 * price every quoted side. Returns all matches, best EV first.
 */
export function buildPropsBoard(
  sharp: SharpProp[],
  soft: SoftPropQuote[],
  league = "MLB",
): PropsBoardRow[] {
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
    const playable = ev >= PROPS_PLAYABLE_FLOOR && ev <= PROPS_SUSPICIOUS_CEILING;
    // HR highlight: an MLB home-run YES (HomeRuns / Over) whose de-vigged fair
    // prob clears the playable EV floor over the soft price. Reuses the EXISTING
    // devig of the sharp HR line (no new model fabricated).
    const hrLike =
      units === "HomeRuns" && q.side === "Over" && ev >= PROPS_PLAYABLE_FLOOR;
    rows.push({
      league,
      player: match.player,
      propType: units,
      line: q.line,
      side: q.side,
      book: q.book,
      softAmerican: q.american,
      fairProb: +fairProb.toFixed(4),
      evPct: +(ev * 100).toFixed(2),
      suspicious: ev > PROPS_SUSPICIOUS_CEILING,
      playable,
      hrLike,
      sharpOverAmerican: match.overAmerican,
      sharpUnderAmerican: match.underAmerican,
      commence: q.commence,
      gameId: q.gameId ?? "",
      team: q.team,
      opponent: q.opponent,
    });
  }
  return rows.sort((a, b) => b.evPct - a.evPct);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only HR-highlight view — surfaces the 🔥 home-run likes the board has
// already flagged, sourced the SAME way the parlay book sources its legs:
// the accumulated props-board log, deduped to the latest tick per leg, kept
// only while the game is still in the future. No new model, no invented number.
// ─────────────────────────────────────────────────────────────────────────────

export interface HomeRunLike {
  player: string;
  line: number;
  book: string;
  softAmerican: number;
  evPct: number;
  team?: string;
  opponent?: string;
  commence: string;
}

type BoardLogRow = PropsBoardRow & { ts: string };

/**
 * Read the props-board log and return the current 🔥 home-run likes — MLB
 * HomeRuns/Over rows the board flagged `hrLike`, whose game has not started.
 * Deduped to the latest tick per (player, line, book), best EV first. Pure
 * read: any missing/empty/corrupt log degrades to `[]` so callers can hide.
 */
export function getHomeRunLikes(
  dir = path.join(process.cwd(), "data", "processed"),
  nowMs = Date.now(),
): HomeRunLike[] {
  let entries: BoardLogRow[] = [];
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, "props-board-log.json"), "utf8"),
    ) as { entries?: BoardLogRow[] };
    entries = parsed.entries ?? [];
  } catch {
    return [];
  }

  const latest = new Map<string, BoardLogRow>();
  for (const r of entries) {
    if (!r.hrLike) continue;
    const commenceMs = new Date(r.commence).getTime();
    if (!Number.isFinite(commenceMs) || commenceMs <= nowMs) continue; // no look-ahead
    const key = `${normalize(r.player)}|${r.line}|${r.book}`;
    const prev = latest.get(key);
    if (!prev || r.ts > prev.ts) latest.set(key, r);
  }

  return [...latest.values()]
    .map((r) => ({
      player: r.player,
      line: r.line,
      book: r.book,
      softAmerican: r.softAmerican,
      evPct: r.evPct,
      team: r.team,
      opponent: r.opponent,
      commence: r.commence,
    }))
    .sort((a, b) => b.evPct - a.evPct);
}
