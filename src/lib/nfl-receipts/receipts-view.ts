// receipts-view.ts — the pure read-model behind /nfl.
//
// Three jobs, all of them things the page got wrong before and must never get
// wrong again:
//
// 1. GROUPING. Control legs carry a DIFFERENT gameId shape
//    ("2026-09-14_cowboys@giants") and a `selection` that is a literal
//    "CONTROL[<legId>]:away" string. Grouping naively on gameId yields 18
//    groups and prints a hex hash into the UI. Controls are excluded here,
//    once, so no caller can forget.
//
// 2. THE TWO PROBABILITIES. Market probability is ALWAYS
//    devigTwoWay(entry, otherSide).byMethod.power from ../nfl-devig — the same
//    function the CLV grader uses. The repo does contain a SECOND devig
//    module (src/lib/devig.ts, imported by ~10 non-receipts modules); the
//    receipts path deliberately never touches it, and this file adds no third.
//    Model probability is ALWAYS `calibratedConfidence`, never
//    `rawConfidence`.
//
// 3. THE GAP. `leg.edge` is a DIFFERENT quantity (computed with multiplicative
//    devig, and an EV-at-price test rather than a probability difference); it
//    disagrees with model - market on 15 of the 16 week-1 moneyline rows
//    (measured 2026-09-09; only MIA @ LV agrees) and is never
//    rendered. The displayed gap is arithmetic on the two rounded numbers that
//    appear in the same row, so a reader can always check it by subtracting.

import { devigTwoWay } from "../nfl-devig";
import type { PublishedBoard, PublishedLeg } from "./board";

/** One decimal place, FP dust removed. Every displayed probability and gap
 *  passes through this, so `gap === model - market` holds exactly. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export interface GameRow {
  gameId: string;
  legId: string;
  /** "AWAY @ HOME" exactly as published. */
  matchup: string;
  awayAbbr: string;
  homeAbbr: string;
  kickoffUtc: string;
  /** The team the model leaned, parsed from the leg's selection. */
  selectedAbbr: string;
  opponentAbbr: string;
  selectedIsAway: boolean;
  /** calibratedConfidence * 100, 1dp. Null if the board carried no model read. */
  modelPct: number | null;
  /** power-devigged fair probability of the selected side * 100, 1dp.
   *  Null when the leg is not CLV-eligible — then the raw prices print
   *  instead and no market probability is claimed. */
  marketPct: number | null;
  /** modelPct - marketPct, 1dp. Null whenever either side is null. */
  gapPp: number | null;
  verdict: "PLAY" | "PASS";
  passReason: string | null;
  entryPriceAmerican: number | null;
  entryOtherSideAmerican: number | null;
  book: string | null;
  snapshotFetchedAt: string | null;
  clvEligible: boolean;
  doctrineNotes: string[];
}

/** Control legs are a placebo arm, not a game we read. They never group and
 *  they never render as a row — they are one counted sentence in THE RULES. */
export function isControl(leg: PublishedLeg): boolean {
  return leg.role === "control";
}

/** Power-devigged fair probability (%) of the side actually taken, or null
 *  when the market was not two-sided at this price. */
export function marketProbPct(leg: PublishedLeg): number | null {
  if (
    !leg.clvEligible ||
    leg.entryPriceAmerican == null ||
    leg.entryOtherSideAmerican == null
  ) {
    return null;
  }
  const fair = devigTwoWay(
    leg.entryPriceAmerican,
    leg.entryOtherSideAmerican,
  ).byMethod.power;
  return round1(fair * 100);
}

/** The model's own number (%) — calibrated, never raw. */
export function modelProbPct(leg: PublishedLeg): number | null {
  if (leg.calibratedConfidence == null) return null;
  return round1(leg.calibratedConfidence * 100);
}

/** Leading team token of a selection: "NYJ ML" -> "NYJ", "NE +3" -> "NE". */
function selectionTeam(selection: string): string {
  return (selection.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

function matchupTeams(matchup: string): { away: string; home: string } {
  const [away = "", home = ""] = matchup.split("@").map((s) => s.trim());
  return { away, home };
}

/** Doctrine notes that are safe to print beside the disagreement.
 *
 *  Every note beginning "2026 gate:" embeds `leg.edge` in prose
 *  ("2026 gate: calibrated edge 16.6% ..."). `leg.edge` was computed with
 *  MULTIPLICATIVE devig against an EV-at-price test; the card's headline is
 *  model - market under POWER devig. Printing both put 16.6% three lines
 *  under "+16.8 pp" — one quantity, two answers, on a screenshot-sized card.
 *  The whole note is dropped; board strings are immutable and are never
 *  rewritten. The self-limitation the note carried ("calibration transferred,
 *  raw edge did not") is restated as page copy instead, where it can be said
 *  without a contradicting number.
 *
 *  The test is the PREFIX, not "%": "non-divisional (raised floor 5%)" and
 *  "divisional (profit engine, floor 3%)" are gate thresholds, not edge
 *  claims, and they survive. */
export function renderableNotes(notes: string[] | undefined): string[] {
  return (notes ?? []).filter((n) => !/^2026 gate:/.test(n.trim()));
}

function toRow(head: PublishedLeg): GameRow {
  const { away, home } = matchupTeams(head.matchup);
  const selected = selectionTeam(head.selection) || (head.side === "home" ? home : away);
  const selectedIsAway = selected === away || (selected !== home && head.side === "away");
  const modelPct = modelProbPct(head);
  const marketPct = marketProbPct(head);
  return {
    gameId: head.gameId,
    legId: head.legId,
    matchup: head.matchup,
    awayAbbr: away,
    homeAbbr: home,
    kickoffUtc: head.kickoffUtc,
    selectedAbbr: selected,
    opponentAbbr: selectedIsAway ? home : away,
    selectedIsAway,
    modelPct,
    marketPct,
    // Arithmetic on the two ROUNDED numbers the row prints — never leg.edge.
    gapPp:
      modelPct == null || marketPct == null ? null : round1(modelPct - marketPct),
    verdict: head.role === "play" ? "PLAY" : "PASS",
    passReason: head.passReason ?? null,
    entryPriceAmerican: head.entryPriceAmerican,
    entryOtherSideAmerican: head.entryOtherSideAmerican,
    book: head.priceProvenance?.book ?? null,
    snapshotFetchedAt: head.priceProvenance?.snapshotFetchedAt ?? null,
    clvEligible: head.clvEligible,
    doctrineNotes: renderableNotes(head.doctrineNotes),
  };
}

/** One row per real game, kickoff-ordered, controls excluded.
 *  The moneyline leg is the head of each group: it is the only market the
 *  2026 doctrine still plays, and its calibrated read is the one the page
 *  prints. ATS and totals legs are counted, never rowed. */
export function gameRows(board: PublishedBoard): GameRow[] {
  const groups = new Map<string, PublishedLeg[]>();
  for (const leg of board.legs) {
    if (isControl(leg)) continue;
    const bucket = groups.get(leg.gameId);
    if (bucket) bucket.push(leg);
    else groups.set(leg.gameId, [leg]);
  }
  const rows: GameRow[] = [];
  for (const legs of groups.values()) {
    // NEVER `?? legs[0]`. With no moneyline leg that promoted an ATS leg to
    // the head, and the page has no spread column: "NYJ +2.5" would print as
    // "NYJ at TEN / MARKET 49.7%" — a COVER probability wearing a
    // win-probability label, with the line silently dropped. A game the
    // doctrine did not read on the moneyline is not a row.
    const head = legs.find((l) => l.market === "moneyline");
    if (!head) continue;
    rows.push(toRow(head));
  }
  rows.sort(
    (a, b) =>
      Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc) ||
      a.matchup.localeCompare(b.matchup),
  );
  return rows;
}

/** How many distinct probabilities the model actually emitted this slate,
 *  and how concentrated they are.
 *
 *  Twelve of week 1's sixteen rows read 63.3%. A reader who does not know the
 *  model's resolution reads that repetition as a broken template, so the page
 *  states it. Computed, not written down: the sentence stays true in a week
 *  whose numbers are different. */
export interface ModelResolution {
  total: number;
  distinct: number;
  /** The most common model probability, or null when nothing was read. */
  modalValue: number | null;
  modalCount: number;
}

export function modelResolution(rows: GameRow[]): ModelResolution {
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.modelPct == null) continue;
    counts.set(r.modelPct, (counts.get(r.modelPct) ?? 0) + 1);
  }
  let modalValue: number | null = null;
  let modalCount = 0;
  for (const [value, n] of counts) {
    if (n > modalCount) {
      modalValue = value;
      modalCount = n;
    }
  }
  return {
    total: rows.filter((r) => r.modelPct != null).length,
    distinct: counts.size,
    modalValue,
    modalCount,
  };
}

export interface BoardCounts {
  games: number;
  legsRead: number; // non-control legs published
  played: number;
  controls: number;
  dropped: number;
  /** ATS + totals legs — counted in one sentence, never rowed. */
  retiredMarketLegs: number;
}

export function boardCounts(board: PublishedBoard): BoardCounts {
  const nonControl = board.legs.filter((l) => !isControl(l));
  return {
    games: gameRows(board).length,
    legsRead: nonControl.length,
    played: nonControl.filter((l) => l.role === "play").length,
    controls: board.legs.filter(isControl).length,
    dropped: board.dropped.length,
    retiredMarketLegs: nonControl.filter((l) => l.market !== "moneyline").length,
  };
}

// ─── Kickoff furniture (ET — the schedule's own timezone) ────────────────────

const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "America/New_York",
});
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/** "SUN SEP 13" — the day band label. */
export function etDayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return DAY_FMT.format(d).replace(/,/g, "").toUpperCase();
}

/** "1:00 PM" — kickoff, ET assumed and stated once per section. */
export function etTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return TIME_FMT.format(d);
}

export interface DayBand {
  label: string;
  rows: GameRow[];
}

/** Kickoff-ordered day bands. NEVER sorted by gap: a schedule is a schedule,
 *  a gap-ranked list is a leaderboard of near-misses that reads as advice. */
export function dayBands(rows: GameRow[]): DayBand[] {
  const bands: DayBand[] = [];
  for (const row of rows) {
    const label = etDayLabel(row.kickoffUtc);
    const last = bands[bands.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else bands.push({ label, rows: [row] });
  }
  return bands;
}

/** Fixed forever at 25pp. The diverge bar must mean the same length every
 *  week; auto-scaling to the week's maximum makes it a lying bar. */
export const DIVERGE_SCALE_PP = 25;

/** Magnitude in [0,1] for the .diverge sparkline. */
export function divergeMagnitude(gapPp: number): number {
  return Math.min(Math.abs(gapPp) / DIVERGE_SCALE_PP, 1);
}

// ─── Formatters ─────────────────────────────────────────────────────────────

export function fmtAmerican(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n > 0 ? `+${n}` : String(n);
}

/** "63.3%" — one decimal, always, so the gap subtracts cleanly on screen. */
export function fmtPct1(x: number | null): string {
  return x == null ? "—" : `${x.toFixed(1)}%`;
}

/** "+12.1" / "-10.4" — signed, one decimal. ASCII sign on purpose: this
 *  string is subtracted back out of the DOM by the acceptance check, and a
 *  typographic minus would have to be normalized by every reader of it. */
export function fmtGap(x: number | null): string {
  if (x == null) return "—";
  return `${x > 0 ? "+" : x < 0 ? "-" : ""}${Math.abs(x).toFixed(1)}`;
}
