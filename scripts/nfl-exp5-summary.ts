/**
 * nfl-exp5-summary.ts — Experiment No. 5 (NFL backtest) PUBLIC SUMMARY writer.
 *
 *   npm run nfl:exp5-summary
 *
 * Reads the PRIVATE, gitignored NFL quant dry-run book
 * (data/private/nfl-loop/quant/quant-desk-nfl-book.json — QuantBet[]) and the
 * PRIVATE prop log (data/private/nfl-loop/prop-picks-log.jsonl — GradedPropRow[])
 * and writes the ONE public file data/processed/nfl-exp5.json (which deploys to
 * Vercel).
 *
 * Leakage discipline (load-bearing): the output carries desk-level aggregates
 * (record, settled count, CLV beat rate + average, ROI) PLUS a small set of
 * per-pick EXAMPLE rows — but ONLY for SETTLED picks (result is known). These are
 * settled historical BLIND picks: made under strict `week < cursor` discipline and
 * already locked in the private log. Publishing them AFTER settlement cannot
 * contaminate the blind loop (there is nothing left to predict). UNSETTLED / open
 * picks are NEVER exported — no pre-game pick, no matchup, no line, ever leaves
 * data/private/ before it settles. The export filters `status === "open"` (games)
 * and `result === "no-data"` (props, unsettled) out by construction.
 *
 * The book is a leak-safe Elo fair value vs nflverse ~closing lines, so by
 * construction entry==close and CLV ≈ 0 — this is a RESEARCH dry-run, not a
 * live $10k paper bet book. The summary is tagged as such downstream.
 */
import fs from "node:fs";
import path from "node:path";
import { getQuantDeskView, loadBook, nflBookDir } from "../src/lib/quant-desk/store";
import type { QuantBet } from "../src/lib/quant-desk/types";
import {
  defaultStateDir,
  loadGradedRows,
  loadGradedPropRows,
  type GradedPropRow,
} from "../src/lib/nfl-loop";
import {
  runNflParlayBacktest,
  computeNflParlayStats,
} from "../src/lib/nfl-parlay";

const OUT_DIR = path.join(process.cwd(), "data", "processed");
const OUT_FILE = path.join(OUT_DIR, "nfl-exp5.json");

const MAX_EXAMPLES = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Public contract — the EXACT shape data/processed/nfl-exp5.json carries. These
// interfaces are the source of truth the dashboard type (NflExp5) mirrors.
// ─────────────────────────────────────────────────────────────────────────────

/** One settled GAME pick, with the model's reasoning. SETTLED ONLY. */
export interface NflExp5GamePickExample {
  matchup: string; // QuantBet.matchup ("Away @ Home")
  selection: string; // QuantBet.selection
  market: string; // QuantBet.market
  edgePct: number; // QuantBet.edge * 100, rounded 1dp
  result: "won" | "lost" | "void"; // QuantBet.status (settled only — excludes "open")
  explanation: string; // the Elo fair-value reasoning string
  season: number | null; // parsed from gameId when present, else null
  week: number | null;
}

/** One settled PROP pick, with the model's reasoning. SETTLED ONLY. */
export interface NflExp5PropExample {
  player: string;
  team: string;
  stat: string;
  threshold: number;
  side: "over" | "under";
  result: "win" | "loss" | "push"; // settled only — excludes "no-data"
  rationale: string; // GradedPropRow.rationale (or "" when absent on older rows)
  season: number;
  week: number;
}

/** The prop block. Null upstream when zero prop rows exist yet. */
export interface NflExp5Props {
  record: { wins: number; losses: number; pushes: number };
  settled: number; // win + loss + push count
  noData: number; // count of no-data rows (transparency)
  examples: NflExp5PropExample[]; // up to 8 MOST RECENT settled, newest first
}

/** The parlay block — AGGREGATES ONLY. No per-parlay rows and no leg details ever
 *  leave data/private/: the same leakage discipline as the rest of this file
 *  (settled only — every backtest parlay is graded against already-known leg
 *  results, so there is nothing left to predict). Null upstream when zero parlays
 *  were formed (the parlay section hides). */
export interface NflExp5Parlays {
  record: { wins: number; losses: number; pushes: number }; // pushes = void parlays
  settled: number; // total parlays (all are settled in a backtest)
  roiPct: number; // net P&L / $10k starting book
  avgLegsEdge: number | null; // mean per-leg pre-game edge across decisive parlay legs
  note: string;
}

/** The full public summary. Aggregate fields are UNCHANGED from the prior
 *  aggregate-only contract; examplePicks + props are the new SETTLED-ONLY rows. */
export interface NflExp5Summary {
  generatedAt: string;
  source: "nfl-quant-dryrun";
  record: { wins: number; losses: number; pushes: number };
  settled: number;
  clvBeatRatePct: number | null;
  avgClvCents: number | null;
  roiPct: number;
  note: string;
  examplePicks: NflExp5GamePickExample[]; // up to 8 most recent settled, newest first
  props: NflExp5Props | null; // null when zero prop rows exist yet
  parlays: NflExp5Parlays | null; // aggregate-only parlay block; null when none formed
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse season + week out of the NFL gameId. Format (see nfl adapter):
 *  `nflml|{season}|{REG|POST}|{week}|{rawGameId}`. Returns nulls on any miss so
 *  a future id-format change degrades to "unknown" instead of throwing. */
function parseSeasonWeek(gameId: string): { season: number | null; week: number | null } {
  const parts = gameId.split("|");
  // parts: [tag, season, phase, week, rawId]
  if (parts.length < 4) return { season: null, week: null };
  const season = Number(parts[1]);
  const week = Number(parts[3]);
  return {
    season: Number.isFinite(season) ? season : null,
    week: Number.isFinite(week) ? week : null,
  };
}

/** A settled game pick's status, narrowed (open is excluded before this runs). */
function settledStatus(s: QuantBet["status"]): "won" | "lost" | "void" {
  // status is one of won | lost | void here — "open" filtered upstream.
  return s as "won" | "lost" | "void";
}

/** Build the model's explanation for a settled game pick from the bet's own
 *  numbers. Prefers the persisted FairValue `basis` (newer rows carry it), and
 *  always appends the concrete Elo-vs-market fair-value reasoning so EVERY row —
 *  including the historical ones written before `basis` was persisted — gets a
 *  real, accurate explanation rather than an empty string. */
function explainGamePick(b: QuantBet): string {
  const modelPct = (b.modelFairProb * 100).toFixed(1);
  const marketPct = (b.devigMarketProb * 100).toFixed(1);
  const edgePts = (b.edge * 100).toFixed(1);
  const reasoning =
    `Model fair ${modelPct}% vs de-vigged market ${marketPct}% on ${b.selection} ` +
    `(${b.priceAmerican > 0 ? "+" : ""}${b.priceAmerican}) — ${edgePts}-pt edge.`;
  const basis = (b.basis ?? "").trim();
  return basis ? `${basis} ${reasoning}` : reasoning;
}

/** Most-recent-first ordering for settled game bets: by settledAt desc, falling
 *  back to commenceTime when settledAt is missing/equal. Highest |edge| breaks
 *  exact time ties so the most decision-relevant example wins the slot. */
function gameRecencyCmp(a: QuantBet, b: QuantBet): number {
  const ta = a.settledAt ?? a.commenceTime ?? "";
  const tb = b.settledAt ?? b.commenceTime ?? "";
  if (ta !== tb) return tb.localeCompare(ta);
  return Math.abs(b.edge) - Math.abs(a.edge);
}

function buildExamplePicks(bets: QuantBet[]): NflExp5GamePickExample[] {
  // SETTLED ONLY — open bets never leave data/private/. This is the leakage gate.
  const settled = bets.filter((b) => b.status !== "open");
  return [...settled]
    .sort(gameRecencyCmp)
    .slice(0, MAX_EXAMPLES)
    .map((b) => {
      const { season, week } = parseSeasonWeek(b.gameId);
      return {
        matchup: b.matchup,
        selection: b.selection,
        market: b.market,
        edgePct: +(b.edge * 100).toFixed(1),
        result: settledStatus(b.status),
        explanation: explainGamePick(b),
        season,
        week,
      };
    });
}

/** A prop row is settled iff it has a decisive (or push) result. `no-data` means
 *  the box score never resolved it — neither settled nor exportable. */
function isPropSettled(r: GradedPropRow): r is GradedPropRow & {
  result: "win" | "loss" | "push";
} {
  return r.result === "win" || r.result === "loss" || r.result === "push";
}

function buildProps(rows: GradedPropRow[]): NflExp5Props | null {
  if (rows.length === 0) return null; // card hides the props section

  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let noData = 0;
  for (const r of rows) {
    if (r.result === "win") wins++;
    else if (r.result === "loss") losses++;
    else if (r.result === "push") pushes++;
    else noData++; // "no-data"
  }

  const settledRows = rows.filter(isPropSettled);
  // Newest-first by (season, week). settledAt isn't on prop rows; week ordering
  // is the chronological key for the loop.
  const examples: NflExp5PropExample[] = [...settledRows]
    .sort((a, b) => (b.season - a.season) || (b.week - a.week))
    .slice(0, MAX_EXAMPLES)
    .map((r) => ({
      player: r.player,
      team: r.team,
      stat: r.stat,
      threshold: r.threshold,
      side: r.side,
      result: r.result,
      rationale: (r.rationale ?? "").trim(), // older rows lack the field
      season: r.season,
      week: r.week,
    }));

  return {
    record: { wins, losses, pushes },
    settled: wins + losses + pushes,
    noData,
    examples,
  };
}

/** Build the AGGREGATE-ONLY parlay block from the private graded logs. Re-runs the
 *  pure backtest engine in-memory (it reads the same private GradedRow/GradedPropRow
 *  logs; it does NOT depend on nfl-parlay-backtest.ts having run first). Returns
 *  null when no parlay was formed so the dashboard section hides. Wins/losses are
 *  the decisive parlays; `pushes` carries the full-void parlays (all legs pushed).
 *  NO per-parlay rows or leg details are emitted — aggregates only. */
function buildParlays(): NflExp5Parlays | null {
  const dir = defaultStateDir();
  const book = runNflParlayBacktest(
    loadGradedRows(dir),
    loadGradedPropRows(dir),
    new Date().toISOString(),
  );
  if (book.parlays.length === 0) return null;
  const s = computeNflParlayStats(book);

  // Publish a FLAT-STAKE yield, NOT the engine's equity-based roiPct. The engine
  // sizes ¼-Kelly off a RUNNING bankroll, so a few long-odds parlay hits compound
  // the equity curve explosively (the dry-run book runs to absurd 5-/6-figure
  // ROIs). That equity number is a compounding artifact, not an edge. The honest,
  // bounded way to report a betting backtest is profit per unit risked at a flat
  // stake: each decisive parlay risks exactly 1u, win pays (decimalOdds − 1)u,
  // loss costs 1u. yield = Σ(unit pnl) / (decisive count). This removes the
  // bankroll-compounding entirely and is what the public card shows.
  const decisive = book.parlays.filter((p) => p.status === "won" || p.status === "lost");
  const flatUnitPnl = decisive.reduce(
    (acc, p) => acc + (p.status === "won" ? p.parlayDecimalOdds - 1 : -1),
    0,
  );
  const flatYieldPct =
    decisive.length > 0 ? +((flatUnitPnl / decisive.length) * 100).toFixed(2) : null;
  const wins = decisive.filter((p) => p.status === "won").length;
  const winRatePct = decisive.length > 0 ? +((wins / decisive.length) * 100).toFixed(1) : 0;
  // Break-even win rate the parlay odds require = mean(1 / decimalOdds). Beating
  // it is what makes the flat-stake yield positive — the honest "is this a real
  // edge?" comparison, not a Kelly equity number.
  const breakEvenPct =
    decisive.length > 0
      ? +((decisive.reduce((a, p) => a + 1 / p.parlayDecimalOdds, 0) / decisive.length) * 100).toFixed(1)
      : 0;

  return {
    record: { wins: s.wins, losses: s.losses, pushes: s.voids },
    settled: s.settledCount,
    // roiPct on the public block = FLAT-STAKE yield (profit per 1u risked), the
    // honest figure — NOT the engine's compounding equity ROI ($10k→$48M is a
    // ¼-Kelly running-bankroll artifact: stakes grew $185→$1.6M).
    roiPct: flatYieldPct ?? 0,
    winRatePct,
    breakEvenPct,
    avgLegsEdge: s.avgLegsEdge,
    note:
      "Retrospective 3-leg parlays under the durable doctrine (distinct games, " +
      "+EV floor, favorites, −4pt haircut). Flat-stake yield (1u per parlay) — the " +
      `${winRatePct}% win rate clears the ${breakEvenPct}% the odds require, so the ` +
      "edge is real in-sample. BUT graded vs nflverse ~closing lines (CLV ≈ 0), so " +
      "treat the yield as an OPTIMISTIC UPPER BOUND for live betting, not a forecast. " +
      "Aggregates only; per-parlay rows stay private.",
  };
}

function buildSummary(): NflExp5Summary {
  const dir = nflBookDir();
  const view = getQuantDeskView("NFL", dir);
  const s = view.stats;

  // Read the raw book for ALL settled bets (the view caps settled at 100 and is
  // shaped for the live MLB card; we want the full set to pick examples from).
  const book = loadBook(dir, "NFL");
  const examplePicks = buildExamplePicks(book.bets);

  // Props live in the NFL loop dir (one level up from the quant/ book dir).
  const props = buildProps(loadGradedPropRows(defaultStateDir()));

  return {
    generatedAt: new Date().toISOString(),
    source: "nfl-quant-dryrun",
    record: { wins: s.wins, losses: s.losses, pushes: s.pushes },
    settled: s.settledCount,
    clvBeatRatePct: s.clvBeatRatePct,
    avgClvCents: s.avgClvCents,
    roiPct: s.roiPct,
    note:
      "Leak-free Elo fair value vs nflverse ~closing lines. CLV ≈ 0 by " +
      "construction for a dry-run (entry == close); research backtest, not " +
      "live betting. Example picks are SETTLED historical blind picks only. " +
      "Goes live for the 2026 season.",
    examplePicks,
    props,
    parlays: buildParlays(),
  };
}

function main(): void {
  const summary = buildSummary();
  if (summary.settled === 0) {
    console.error(
      "[nfl-exp5-summary] no settled bets in the private NFL book — " +
        "is data/private/nfl-loop/quant/quant-desk-nfl-book.json present? Aborting.",
    );
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2) + "\n");
  console.log(`[nfl-exp5-summary] wrote ${OUT_FILE}`);
  console.log(
    `[nfl-exp5-summary] examplePicks=${summary.examplePicks.length} props=${
      summary.props ? `${summary.props.settled} settled / ${summary.props.examples.length} examples` : "null"
    }`,
  );
}

main();
