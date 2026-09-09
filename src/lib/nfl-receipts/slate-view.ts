// slate-view.ts — the pure read-model behind /nfl's THE MARKET NOW section.
//
// The published board is FROZEN at publish; this table is the sharp market as
// of the last daily refresh. They are two different things about the same
// games and the page says so — which is why this module deliberately does NOT
// join the slate to the board. A kickoff-keyed pair join across an odds feed
// that spans the whole season is exactly the trap that has bitten this route
// before; there is no claim here that needs one. Each surface states its own
// provenance and its own instant, and the reader does the comparison.
//
// Every probability on this page comes from ONE devig. The slate file was
// written by site-slate.ts, which calls
// `devigTwoWay(...).byMethod.power` — the same function the CLV grader and the
// receipts view use. This module re-devigs nothing; it formats what is there.

import type { NflSlate, NflSlateGame } from "./site-slate";

export interface SlateRow {
  kickoffUtc: string;
  /** "Seahawks" — nickname only, so a 16-row agate table stays narrow. */
  awayShort: string;
  homeShort: string;
  awayTeam: string;
  homeTeam: string;
  moneylineAway: number | null;
  moneylineHome: number | null;
  /** De-vigged (power) fair win probability, percent, 1dp. Null with no
   *  two-sided moneyline — never zero, which would read as a claim. */
  fairAwayPct: number | null;
  fairHomePct: number | null;
  spreadPoint: number | null;
  spreadHomePrice: number | null;
  totalPoint: number | null;
}

export interface SlateBand {
  label: string;
  rows: SlateRow[];
}

/** Every NFL nickname is the final token of the full name
 *  ("Kansas City Chiefs" → "Chiefs", "San Francisco 49ers" → "49ers").
 *  A name with no space passes through rather than becoming "". */
export function slateNickname(full: string): string {
  const t = full.trim();
  if (!t) return "";
  const parts = t.split(/\s+/);
  return parts[parts.length - 1] ?? t;
}

function pct1(x: number | null | undefined): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x * 1000) / 10;
}

export function slateRow(g: NflSlateGame): SlateRow {
  return {
    kickoffUtc: g.kickoffUtc,
    awayShort: slateNickname(g.away_team),
    homeShort: slateNickname(g.home_team),
    awayTeam: g.away_team,
    homeTeam: g.home_team,
    moneylineAway: g.moneyline?.away ?? null,
    moneylineHome: g.moneyline?.home ?? null,
    fairAwayPct: pct1(g.fairAwayProb),
    fairHomePct: pct1(g.fairHomeProb),
    spreadPoint: g.spread?.point ?? null,
    spreadHomePrice: g.spread?.home ?? null,
    totalPoint: g.total?.point ?? null,
  };
}

/** Kickoff-ordered rows. The slate file is already sorted by the builder; this
 *  sorts again so a hand-edited or re-ordered file cannot present a schedule
 *  out of order — the one ordering this page allows. */
export function slateRows(slate: NflSlate | null): SlateRow[] {
  if (!slate || !Array.isArray(slate.games)) return [];
  return slate.games
    .filter((g) => g && typeof g.kickoffUtc === "string")
    .map(slateRow)
    .sort(
      (a, b) =>
        Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc) ||
        a.homeShort.localeCompare(b.homeShort),
    );
}

/** Day bands, keyed by an ET day label supplied by the caller (the receipts
 *  view owns the one Intl formatter this page uses; passing it in keeps a
 *  second timezone implementation from appearing here). */
export function slateBands(
  rows: SlateRow[],
  dayLabel: (iso: string) => string,
): SlateBand[] {
  const bands: SlateBand[] = [];
  for (const row of rows) {
    const label = dayLabel(row.kickoffUtc);
    const last = bands[bands.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else bands.push({ label, rows: [row] });
  }
  return bands;
}

/** "-170" / "+149" / "—". Shared shape with fmtAmerican in receipts-view; kept
 *  here so the slate table has no dependency on the board's view model. */
export function fmtSlatePrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n > 0 ? `+${n}` : String(n);
}

/** "-3.5 (-110)" — the home side's number, always, stated once in the column
 *  head. A spread with no price prints the point alone rather than inventing
 *  a juice figure. */
export function fmtSlateSpread(point: number | null, homePrice: number | null): string {
  if (point == null || !Number.isFinite(point)) return "—";
  const p = point > 0 ? `+${point}` : String(point);
  return homePrice == null ? p : `${p} (${fmtSlatePrice(homePrice)})`;
}

/** "44.5" — the total's point. */
export function fmtSlateTotal(point: number | null): string {
  if (point == null || !Number.isFinite(point)) return "—";
  return String(point);
}

/** "61%" — fair probabilities print WHOLE percents in this table. The board
 *  above prints one decimal because a reader subtracts two of its numbers;
 *  nothing here is subtracted, and 16 rows of "61.6%" is false precision on a
 *  line that moves every day. */
export function fmtFairPct(x: number | null): string {
  return x == null ? "—" : `${Math.round(x)}%`;
}

/** The two sides of one game, as whole percents that SUM TO 100.
 *
 *  Rounding each side independently prints "19% / 82%" for Cardinals–Chargers
 *  and "48% / 53%" for Jets–Titans — MEASURED on the committed slate, four of
 *  sixteen rows. Two complementary probabilities that add to 101 are the kind
 *  of thing a careful reader screenshots, and they are complementary by
 *  construction: site-slate.ts derives the away side as 1 − home. So the home
 *  side is rounded and the away side is DERIVED from the rounded figure, which
 *  keeps the printed pair internally consistent at the cost of at most half a
 *  point on one side — a precision this table does not claim anyway. */
export function fairPairWhole(
  fairHomePct: number | null,
  fairAwayPct: number | null,
): { away: number | null; home: number | null } {
  if (fairHomePct != null) {
    const home = Math.round(fairHomePct);
    return { home, away: 100 - home };
  }
  // No home read but an away read: anchor on whichever side the file has.
  if (fairAwayPct != null) {
    const away = Math.round(fairAwayPct);
    return { away, home: 100 - away };
  }
  return { away: null, home: null };
}
