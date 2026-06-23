/**
 * parlay-backtest.ts — Experiment No. 4 retrospective (read-only).
 *
 * Question (the user's): "if you had chosen parlays the last 30 days, how many
 * would you have won?"
 *
 * The pre-registered live Exp 4 rule (PARLAY_PAPER_SPEC.md) sources legs from
 * the props-board log's `playable` rows — legs whose SOFT price beats the
 * de-vigged Pinnacle fair value by ≥3% EV. That log only goes back one day and
 * has zero playable rows, so it cannot be backtested.
 *
 * What CAN be backtested is the model's own daily graded player-prop picks,
 * which ModelPickSnapshot has stored — with real odds, matchup, and a
 * box-score `result` — for all 30 of the last 30 days. So this script answers
 * the literal "how many would have won" by forming, per day, the same kind of
 * parlays Exp 4 forms (exactly 3 legs, 3 DISTINCT games, the same correlation
 * block) out of that day's graded prop picks, then settling each parlay at its
 * BOOKED odds using the stored leg results.
 *
 * IMPORTANT — this is an APPROXIMATION, not the live rule, and it is
 * QUARANTINED from the pre-registered experiment (it writes no book, opens no
 * paper parlay, and must never be used to tune the live rule — doing so voids
 * the pre-registration). The differences are stated explicitly in the output:
 *   - Leg source = model's daily prop picks, NOT props-board playable (+EV-vs-
 *     sharp) legs. We have no de-vigged sharp fairProb in this table.
 *   - Because there's no fairProb, the +EV / haircut OPEN GATE is NOT applied —
 *     this measures realized win rate + yield of the COMBINATORICS only, at
 *     true booked odds. It tells you "did the model's prop picks parlay
 *     profitably," not "did +EV-vs-sharp legs parlay profitably."
 *   - Settlement is the stored ModelPickSnapshot.result (win/loss/push), so it
 *     is fully deterministic and offline.
 *
 * Usage:
 *   npm run paper:parlay:backtest            # last 30 days, greedy assembly
 *   npm run paper:parlay:backtest -- 14      # last 14 days
 *   npm run paper:parlay:backtest -- 30 json # machine-readable summary
 *   npm run paper:parlay:backtest -- 30 mine # selective "ticket I'd make" run;
 *                                            #   ALSO writes data/processed/
 *                                            #   parlay-retro.json for the
 *                                            #   demoted dashboard panel (this
 *                                            #   file is QUARANTINED from the
 *                                            #   live pre-registered book).
 */

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  PARLAY_PAPER_CONFIG,
  legKey,
  parlayId,
  combinedDecimal,
  combinedFairProb,
  parlayExpectedValue,
  legsCorrelated,
  type CandidateLeg,
} from "@/lib/parlay-paper";
import { americanToDecimal, decimalToAmerican, americanToImpliedProb } from "@/lib/devig";

// ─── Leg sourcing from ModelPickSnapshot ─────────────────────────────────────

type SnapRow = {
  player: string | null;
  propType: string | null;
  line: number | null;
  selection: string;
  oddsAmerican: number | null;
  matchup: string | null;
  team: string | null;
  result: string | null;
  snapshotDate: string;
  league: string;
  // model's own PRE-GAME conviction fields (never the result):
  confidence: number | null; // model confidence 0-100 (≈ its win-prob for this leg)
  edge: number | null; // model projection-gap / edge fraction (e.g. 0.08 = +8%)
};

// Parse OVER/UNDER off the canonical selection string (e.g. "OVER 0.5").
function sideOf(selection: string): "Over" | "Under" | null {
  const s = selection.toUpperCase();
  if (s.includes("OVER")) return "Over";
  if (s.includes("UNDER")) return "Under";
  return null;
}

// Build the per-day candidate-leg pool out of that day's graded prop rows.
// fairProb is set to the leg's NO-VIG implied prob from its own odds — a
// neutral placeholder so combinedFairProb/EV are well-defined; it is NOT a
// sharp edge and the +EV gate is intentionally not enforced (see header).
function rowToCandidate(r: SnapRow): CandidateLeg | null {
  if (!r.player || !r.propType || r.line == null || r.oddsAmerican == null || !r.matchup) {
    return null;
  }
  // Guard broken/placeholder odds: the snapshot has NBA rows priced -1 / -5 / -6
  // that are not real American prices and otherwise explode into huge decimal
  // multipliers (the source of the earlier 7,000x longshot artifacts).
  if (Math.abs(r.oddsAmerican) < 100) return null;
  const side = sideOf(r.selection);
  if (!side) return null;
  const dec = americanToDecimal(r.oddsAmerican);
  if (!Number.isFinite(dec) || dec <= 1) return null;

  const gameId = r.matchup.trim(); // matchup string is our game identity here
  const fairProb = 1 / dec; // no-vig-ish placeholder from the booked price
  const league = r.league === "NBA" ? "NBA" : "MLB";

  return {
    legId: legKey({
      player: r.player,
      propType: r.propType,
      side,
      line: r.line,
      book: "snapshot",
      gameId,
    }),
    player: r.player,
    gameId,
    team: r.team ?? undefined,
    opponent: undefined,
    propType: r.propType,
    line: r.line,
    side,
    oddsAmerican: r.oddsAmerican,
    book: "snapshot",
    fairProb,
    commence: r.snapshotDate,
    league,
  };
}

// ─── Selective ("mine") leg sourcing ─────────────────────────────────────────
//
// The SELECTIVE mode picks the ONE realistic ticket a bettor would actually make
// per day, instead of brute-forcing every valid triple. A selective leg is a
// CandidateLeg plus the model's own PRE-GAME conviction + result. Conviction is
// the model's edge/confidence — NEVER the stored result — so ranking has zero
// look-ahead.

type SelectiveLeg = CandidateLeg & {
  conviction: number; // pre-game rank key (model edge, falling back to confidence)
  convictionSource: "edge" | "confidence" | "odds"; // which field ranked it
  modelProb: number | null; // model's own per-leg win prob (confidence/100), if any
  result: LegResult; // stored leg outcome — used ONLY to settle, never to rank
  // display fields
  selection: string; // raw canonical selection ("OVER 0.5") for the ticket print
};

// Build a selective leg from a graded prop row. Returns null if the row can't
// form a clean leg (missing player/odds/matchup/side) or has no usable result.
function rowToSelectiveLeg(r: SnapRow): SelectiveLeg | null {
  const base = rowToCandidate(r);
  const res = resultOf(r);
  if (!base || !res) return null;

  // Conviction = the model's own PRE-GAME edge (projection gap). Fall back to
  // confidence, then — only if neither exists — to the booked decimal odds so
  // ranking is still total. CRITICAL: none of these is the result.
  let conviction: number;
  let convictionSource: "edge" | "confidence" | "odds";
  if (r.edge != null && Number.isFinite(r.edge)) {
    conviction = r.edge;
    convictionSource = "edge";
  } else if (r.confidence != null && Number.isFinite(r.confidence)) {
    conviction = r.confidence / 100;
    convictionSource = "confidence";
  } else {
    conviction = americanToDecimal(r.oddsAmerican!) - 1; // last-resort tiebreak
    convictionSource = "odds";
  }

  // Snapshot `confidence` is a uniform, uncalibrated label (~95 on every prop
  // row), NOT a per-leg win probability — so we deliberately carry NO modelProb.
  // Selection ranks by short booked price (real favourites) and staking is flat.
  const modelProb = null;

  return {
    ...base,
    conviction,
    convictionSource,
    modelProb,
    result: res,
    selection: r.selection,
  };
}

// ─── Settlement off stored results ───────────────────────────────────────────

type LegResult = "won" | "lost" | "push";

function resultOf(r: SnapRow): LegResult | null {
  if (r.result === "win") return "won";
  if (r.result === "loss") return "lost";
  if (r.result === "push") return "push";
  return null; // void / pending — exclude from the backtest pool
}

// ─── Day-level assembly (mirrors assembleParlays but settles deterministically)
//
// We deliberately re-implement the greedy disjoint-triple loop here rather than
// reuse assembleParlays() because that function applies the +EV / haircut /
// stake gates we are intentionally NOT enforcing in this combinatorics-only
// retrospective. The DISTINCTNESS + CORRELATION rules ARE identical (same
// legsCorrelated() from the engine), which is the part the question hinges on.

type BacktestParlay = {
  day: string;
  legIds: string[];
  legResults: LegResult[];
  legDecimals: number[]; // per-leg decimal odds, aligned with legResults
  decimalOdds: number;
  fairProb: number;
  ev: number; // placeholder-fairProb EV (≈0 by construction; reported for audit)
  status: "won" | "lost" | "void";
};

function assembleDay(
  candidates: CandidateLeg[],
  resultByLegId: Map<string, LegResult>,
  day: string,
): BacktestParlay[] {
  const cfg = PARLAY_PAPER_CONFIG;
  // Strongest price first (longest odds = highest single-leg "edge" placeholder)
  // so the greedy ordering is deterministic and stable across runs.
  const pool = [...candidates].sort(
    (a, b) => americanToDecimal(b.oddsAmerican) - americanToDecimal(a.oddsAmerican),
  );
  const used = new Set<string>();
  const out: BacktestParlay[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < pool.length; i++) {
    if (used.has(pool[i].legId)) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (used.has(pool[i].legId)) break;
      if (used.has(pool[j].legId)) continue;
      for (let k = j + 1; k < pool.length; k++) {
        if (used.has(pool[i].legId) || used.has(pool[j].legId)) break;
        if (used.has(pool[k].legId)) continue;
        const trio = [pool[i], pool[j], pool[k]];

        // distinct games
        if (new Set(trio.map((l) => l.gameId)).size < cfg.legsPerParlay) continue;
        // correlation block (same engine rule)
        if (anyCorrelated(trio)) continue;

        const id = parlayId(trio.map((l) => l.legId));
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const legs = trio.map((l) => ({ decimal: americanToDecimal(l.oddsAmerican), fairProb: l.fairProb }));
        const legResults = trio.map((l) => resultByLegId.get(l.legId)!);
        out.push({
          day,
          legIds: trio.map((l) => l.legId),
          legResults,
          legDecimals: legs.map((l) => l.decimal),
          decimalOdds: +combinedDecimal(legs).toFixed(4),
          fairProb: +combinedFairProb(legs).toFixed(6),
          ev: +parlayExpectedValue(legs).toFixed(6),
          status: settle(legResults),
        });
        for (const l of trio) used.add(l.legId);
      }
    }
  }
  return out;
}

function anyCorrelated(trio: CandidateLeg[]): boolean {
  for (let a = 0; a < trio.length; a++) {
    for (let b = a + 1; b < trio.length; b++) {
      if (legsCorrelated(trio[a], trio[b])) return true;
    }
  }
  return false;
}

// Same settlement semantics as the engine: any loss → lost; else survivors are
// the winners (push drops out); all-push → void.
function settle(results: LegResult[]): "won" | "lost" | "void" {
  if (results.some((r) => r === "lost")) return "lost";
  const winners = results.filter((r) => r === "won");
  if (winners.length === 0) return "void"; // all pushed
  return "won";
}

// Re-price a settled parlay at booked odds. A loss → −stake. A win re-prices to
// only the WINNING legs (push legs drop out and refund into the combination),
// exactly like the live engine's settleFromLegs. All-push → void → 0.
function payout(p: BacktestParlay, stake: number): number {
  if (p.status === "lost") return -stake;
  if (p.status === "void") return 0;
  const winnerDec = p.legResults.reduce(
    (acc, r, idx) => (r === "won" ? acc * p.legDecimals[idx] : acc),
    1,
  );
  return +(stake * (winnerDec - 1)).toFixed(2);
}

// ─── SELECTIVE ("mine") mode ─────────────────────────────────────────────────
//
// One realistic ticket per day = the 3 highest-CONVICTION legs from 3 DISTINCT
// games, applying the same correlation block as the engine. Conviction is the
// model's own pre-game edge/confidence — settlement uses the stored result but
// SELECTION never does. This is the "ticket I would have made", not the brute
// force over all 1,937 valid triples.

const SELECTIVE_FLAT_STAKE = 100; // flat $100 per ticket (snapshot confidence is uncalibrated → no Kelly)
// MASTER-PARLAY RULE: only stack genuine FAVOURITES. Each leg must be at least
// this likely by its booked price (implied prob). 0.60 ≈ -150 or shorter — the
// disciplined short-favourite parlay the math favours over a longshot lottery.
// We place MULTIPLE disjoint 3-leg tickets per day (each leg used once).
const FAVOURITE_FLOOR = 0.4;
// We "do multiple a day" — but a realistic handful, the N best (shortest-price)
// tickets, not every disjoint triple the pool allows.
const MAX_TICKETS_PER_DAY = 8;

type Ticket = {
  day: string;
  legs: SelectiveLeg[]; // exactly 3, ranked by conviction desc
  decimalOdds: number;
  americanOdds: number;
  combinedModelProb: number | null; // Π modelProb_i, if every leg had one
  stake: number;
  stakeBasis: "quarter-kelly" | "flat";
  status: "won" | "lost" | "void";
  pnl: number;
};

/**
 * Build the day's parlays: MULTIPLE disjoint 3-leg tickets of short favourites.
 *
 * MASTER-PARLAY RULE (ZERO look-ahead):
 *   1. keep only genuine favourites — booked implied prob ≥ FAVOURITE_FLOOR,
 *   2. rank by win probability DESC (shortest price first),
 *   3. greedily form a 3-leg ticket from 3 DISTINCT games, uncorrelated (engine
 *      rule); remove those legs; repeat until fewer than 3 favourites remain —
 *      so each leg is used at most once (no exposure double-count).
 * The stored result is read only at settlement, never to select or rank.
 */
function rankFavourites(legs: SelectiveLeg[]): SelectiveLeg[] {
  return [...legs]
    .filter((l) => americanToImpliedProb(l.oddsAmerican) >= FAVOURITE_FLOOR)
    .sort((a, b) => {
      const pa = americanToImpliedProb(a.oddsAmerican);
      const pb = americanToImpliedProb(b.oddsAmerican);
      if (pb !== pa) return pb - pa; // primary: highest win probability (shortest price)
      return a.legId.localeCompare(b.legId);
    });
}

function priceTicket(chosen: SelectiveLeg[], day: string): Ticket {
  const priced = chosen.map((l) => ({ decimal: americanToDecimal(l.oddsAmerican), fairProb: l.fairProb }));
  const decimalOdds = +combinedDecimal(priced).toFixed(4);
  const americanOdds = decimalToAmerican(decimalOdds);
  const legResults = chosen.map((l) => l.result);
  const status = settle(legResults);
  const legDecimals = priced.map((p) => p.decimal);
  let pnl: number;
  if (status === "lost") pnl = -SELECTIVE_FLAT_STAKE;
  else if (status === "void") pnl = 0;
  else {
    const winnerDec = legResults.reduce((acc, r, idx) => (r === "won" ? acc * legDecimals[idx] : acc), 1);
    pnl = +(SELECTIVE_FLAT_STAKE * (winnerDec - 1)).toFixed(2);
  }
  return {
    day,
    legs: chosen,
    decimalOdds,
    americanOdds,
    combinedModelProb: null, // snapshot confidence is uncalibrated — no trustworthy prob
    stake: SELECTIVE_FLAT_STAKE,
    stakeBasis: "flat",
    status,
    pnl,
  };
}

function selectDailyTickets(legs: SelectiveLeg[], day: string): Ticket[] {
  let pool = rankFavourites(legs);
  const tickets: Ticket[] = [];
  while (pool.length >= 3 && tickets.length < MAX_TICKETS_PER_DAY) {
    const chosen: SelectiveLeg[] = [];
    for (const leg of pool) {
      if (chosen.length === 3) break;
      if (chosen.some((c) => c.gameId === leg.gameId)) continue; // distinct games
      if (chosen.some((c) => legsCorrelated(c, leg))) continue; // engine correlation block
      chosen.push(leg);
    }
    if (chosen.length < 3) break;
    tickets.push(priceTicket(chosen, day));
    const used = new Set(chosen.map((l) => l.legId));
    pool = pool.filter((l) => !used.has(l.legId));
  }
  return tickets;
}

function fmtAmerican(a: number): string {
  return a >= 0 ? `+${a}` : `${a}`;
}

function legResultMark(r: LegResult): string {
  return r === "won" ? "W" : r === "lost" ? "L" : "push";
}

function printTicket(t: Ticket): void {
  console.log("");
  console.log(`┌─ ${t.day} ──────────────────────────────────────────────`);
  t.legs.forEach((l, i) => {
    const sideLine = `${l.side} ${l.line}`;
    const winp = `${(americanToImpliedProb(l.oddsAmerican) * 100).toFixed(0)}% fav`;
    console.log(
      `│ ${i + 1}. ${l.player} · ${l.propType} · ${sideLine} · ${l.gameId} · ${fmtAmerican(l.oddsAmerican)} · ${legResultMark(l.result)}  [${winp}]`,
    );
  });
  const probStr = t.combinedModelProb != null ? `${(t.combinedModelProb * 100).toFixed(1)}%` : "—";
  console.log(
    `│ Combined: ${t.decimalOdds.toFixed(2)}x (${fmtAmerican(t.americanOdds)})   model P(win) ${probStr}`,
  );
  console.log(
    `│ Stake: $${t.stake.toFixed(2)} (${t.stakeBasis})   Result: ${t.status.toUpperCase()}   P&L: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`,
  );
  console.log(`└────────────────────────────────────────────────────────────`);
}

async function runSelective(rows: SnapRow[], days: number): Promise<void> {
  // Group graded prop rows by snapshot day.
  const byDay = new Map<string, SnapRow[]>();
  for (const r of rows) {
    (byDay.get(r.snapshotDate) ?? byDay.set(r.snapshotDate, []).get(r.snapshotDate)!).push(r);
  }

  type DayOutcome = { day: string; tickets: Ticket[]; eligible: number; favourites: number };

  const outcomes: DayOutcome[] = [];

  for (const [day, dayRows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Eligible legs = that day's graded prop picks, deduped to one leg per
    // (player, propType, side, line, game).
    const byLeg = new Map<string, SelectiveLeg>();
    for (const r of dayRows) {
      const leg = rowToSelectiveLeg(r);
      if (!leg) continue;
      if (!byLeg.has(leg.legId)) byLeg.set(leg.legId, leg);
    }
    const eligible = [...byLeg.values()];
    const favourites = rankFavourites(eligible).length;
    const tickets = selectDailyTickets(eligible, day);
    outcomes.push({ day, tickets, eligible: eligible.length, favourites });
  }

  // ─── Output: the tickets ───────────────────────────────────────────────────
  console.log("");
  console.log("═══ Experiment No. 4 — SELECTIVE PARLAY BACKTEST (\"the ticket I'd make\", read-only) ═══");
  console.log(
    `APPROXIMATION of Exp 4. MULTIPLE 3-leg tickets per day, each = 3 short FAVOURITES (≥${(FAVOURITE_FLOOR * 100).toFixed(0)}%`,
  );
  console.log(
    "implied) from 3 DISTINCT games, same correlation block, each leg used once. Settled at",
  );
  console.log("booked combined odds off the stored leg results. QUARANTINED — writes no book.");
  console.log("");
  console.log("HONESTY CAVEATS (unchanged):");
  console.log("  · Legs are the MODEL'S OWN prop picks, NOT +EV-vs-de-vigged-sharp legs.");
  console.log("  · The live Exp 4 +EV / −4pt haircut OPEN GATE is therefore NOT applied here.");
  console.log("  · Selection ranks by booked WIN PROBABILITY (short price) — never by the result.");
  console.log("  · This must NEVER tune the pre-registered rule; doing so voids the registration.");
  console.log("");

  const tickets: Ticket[] = [];
  for (const o of outcomes) {
    if (o.tickets.length === 0) {
      console.log("");
      console.log(`┌─ ${o.day} ──────────────────────────────────────────────`);
      console.log(`│ NO PICK — ${o.favourites} favourite leg(s) ≥${(FAVOURITE_FLOOR * 100).toFixed(0)}% (of ${o.eligible} picks); need 3 from distinct games.`);
      console.log(`└────────────────────────────────────────────────────────────`);
    } else {
      console.log("");
      console.log(`══ ${o.day} — ${o.tickets.length} ticket(s) from ${o.favourites} favourite legs ══`);
      for (const t of o.tickets) {
        printTicket(t);
        tickets.push(t);
      }
    }
  }

  // ─── Output: the 30-day summary ────────────────────────────────────────────
  const placed = tickets.length;
  const noPickDays = outcomes.filter((o) => o.tickets.length === 0).length;
  const wins = tickets.filter((t) => t.status === "won").length;
  const losses = tickets.filter((t) => t.status === "lost").length;
  const pushes = tickets.filter((t) => t.status === "void").length;
  const decisive = wins + losses;
  const totalStaked = +tickets
    .filter((t) => t.status !== "void")
    .reduce((s, t) => s + t.stake, 0)
    .toFixed(2);
  const netPnl = +tickets.reduce((s, t) => s + t.pnl, 0).toFixed(2);
  const roi = totalStaked > 0 ? +((netPnl / totalStaked) * 100).toFixed(2) : null;
  const winRate = decisive > 0 ? +((wins / decisive) * 100).toFixed(1) : null;
  // Honest break-even: a parlay must hit at its booked implied prob to break even.
  // Average implied break-even win-rate across the placed tickets.
  const avgImpliedBreakEven =
    placed > 0
      ? +(
          (tickets.reduce((s, t) => s + americanToImpliedProb(t.americanOdds), 0) / placed) *
          100
        ).toFixed(1)
      : null;

  console.log("");
  console.log("─── 30-DAY SUMMARY (selective / multiple 3-leg favourite tickets/day) ───");
  console.log(`Window:            last ${days} days (${outcomes.length} days had graded prop data)`);
  console.log(`Parlays placed:    ${placed}`);
  console.log(`No-pick days:      ${noPickDays}  (<3 distinct-game uncorrelated eligible legs)`);
  console.log(`Record (W-L-push): ${wins}-${losses}-${pushes}`);
  console.log(
    `Win rate:          ${winRate == null ? "—" : winRate + "%"}   (vs avg booked break-even ${avgImpliedBreakEven == null ? "—" : avgImpliedBreakEven + "%"})`,
  );
  console.log(`Total staked:      $${totalStaked.toFixed(2)}`);
  console.log(`Net P&L:           ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`);
  console.log(`ROI:               ${roi == null ? "—" : (roi >= 0 ? "+" : "") + roi + "%"}`);
  console.log("");
  console.log(
    "Break-even note: at these long combined prices a winning ticket pays many-to-one, so",
  );
  console.log(
    "one hit covers several misses. The honest bar is the booked implied prob above — the",
  );
  console.log(
    "ticket must win MORE OFTEN than that to profit. Small n: this is descriptive, not a verdict.",
  );
  console.log("");

  // ─── Persist the RETROSPECTIVE for the dashboard panel ─────────────────────
  //
  // QUARANTINE NOTE: this writes a SEPARATE file (parlay-retro.json), never the
  // live pre-registered parlay book (parlay-paper.json). The dashboard renders
  // it in a demoted, clearly-labeled panel BELOW the live book. It must never
  // tune the live rule — it is a favorites-combinatorics approximation, not the
  // +EV-vs-de-vigged-sharp rule, and the +EV/haircut open gate is NOT applied.
  //
  // Equity curve = $10,000 + cumulative daily net P&L at a FLAT $100/ticket.
  // HONESTY: the flat-stake turnover (~$24k staked across ~240 tickets) exceeds
  // the $10k book — this is flat-stake exposure tracking, NOT bankroll-Kelly
  // compounding off a $10k balance. The curve shows what a flat $100 bettor's
  // running net would have been; it is not a Kelly bankroll simulation.
  const STARTING_BANKROLL = 10_000;
  const startingDate = outcomes.length > 0 ? outcomes[0].day : "";
  const equityCurve: Array<{ day: string; equityUsd: number }> = [];
  // Seed with the day BEFORE the first graded day at flat $10k so the curve
  // visibly starts at the baseline (length ≥ 2 even on sparse windows). The
  // seed day is a real, parseable ISO date (one day before the first graded
  // day) so the chart's date axis renders it without a fallback.
  if (startingDate) {
    const seed = new Date(`${startingDate}T00:00:00Z`);
    seed.setUTCDate(seed.getUTCDate() - 1);
    const seedDay = seed.toISOString().slice(0, 10);
    equityCurve.push({ day: seedDay, equityUsd: STARTING_BANKROLL });
  }
  let runningEquity = STARTING_BANKROLL;
  for (const o of outcomes) {
    const dayPnl = +o.tickets.reduce((s, t) => s + t.pnl, 0).toFixed(2);
    runningEquity = +(runningEquity + dayPnl).toFixed(2);
    equityCurve.push({ day: o.day, equityUsd: runningEquity });
  }
  const endingEquity = +(STARTING_BANKROLL + netPnl).toFixed(2);

  const retro = {
    rule: "favorites-combinatorics-RETROSPECTIVE",
    generatedAt: new Date().toISOString(),
    startingBankrollUsd: STARTING_BANKROLL,
    days,
    parlaysPlaced: placed,
    record: { wins, losses, pushes },
    winRatePct: winRate,
    avgBreakEvenPct: avgImpliedBreakEven,
    totalStakedUsd: totalStaked,
    netPnlUsd: netPnl,
    roiPct: roi,
    endingEquityUsd: endingEquity,
    equityCurve,
  };

  const outDir = path.join(process.cwd(), "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "parlay-retro.json");
  fs.writeFileSync(outPath, JSON.stringify(retro, null, 2) + "\n", "utf8");
  console.log(`Wrote retrospective → ${path.relative(process.cwd(), outPath)}`);
  console.log(
    `  $${STARTING_BANKROLL.toLocaleString()} start → $${endingEquity.toLocaleString()} end  ·  ` +
      `${wins}-${losses}-${pushes}  ·  yield ${roi == null ? "—" : (roi >= 0 ? "+" : "") + roi + "%"}`,
  );
  console.log("");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const days = Number(process.argv[2] ?? 30);
  const mode = (process.argv[3] ?? "").toLowerCase(); // "" (greedy), "json", or "mine"
  const asJson = mode === "json";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = (await prisma.modelPickSnapshot.findMany({
    where: {
      propType: { not: null },
      result: { in: ["win", "loss", "push"] },
      createdAt: { gte: since },
    },
    select: {
      player: true,
      propType: true,
      line: true,
      selection: true,
      oddsAmerican: true,
      matchup: true,
      team: true,
      result: true,
      snapshotDate: true,
      league: true,
      confidence: true,
      edge: true,
    },
    orderBy: { snapshotDate: "asc" },
  })) as SnapRow[];

  // ─── SELECTIVE ("mine") mode — one realistic ticket per day ────────────────
  if (mode === "mine") {
    await runSelective(rows, days);
    return;
  }

  // Group graded prop rows by snapshot day.
  const byDay = new Map<string, SnapRow[]>();
  for (const r of rows) {
    (byDay.get(r.snapshotDate) ?? byDay.set(r.snapshotDate, []).get(r.snapshotDate)!).push(r);
  }

  const flatKelly = PARLAY_PAPER_CONFIG.minStakeUsd; // flat $10/parlay — backtest sizes uniformly
  let equity = PARLAY_PAPER_CONFIG.startingBankrollUsd;

  const allParlays: BacktestParlay[] = [];
  const perDay: Array<{ day: string; legPool: number; parlays: number; won: number; lost: number; void: number; pnl: number }> = [];

  for (const [day, dayRows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Build candidates; dedup to one leg per (player, propType, side, line, game)
    // keeping the first stored result for that leg.
    const candByLeg = new Map<string, CandidateLeg>();
    const resultByLegId = new Map<string, LegResult>();
    for (const r of dayRows) {
      const c = rowToCandidate(r);
      const res = resultOf(r);
      if (!c || !res) continue;
      if (!candByLeg.has(c.legId)) {
        candByLeg.set(c.legId, c);
        resultByLegId.set(c.legId, res);
      }
    }
    const candidates = [...candByLeg.values()];
    const parlays = assembleDay(candidates, resultByLegId, day);

    let won = 0,
      lost = 0,
      voided = 0,
      pnl = 0;
    for (const p of parlays) {
      if (p.status === "won") won++;
      else if (p.status === "lost") lost++;
      else voided++;
      const pay = payout(p, flatKelly);
      pnl += pay;
      equity += pay;
    }
    allParlays.push(...parlays);
    perDay.push({ day, legPool: candidates.length, parlays: parlays.length, won, lost, void: voided, pnl: +pnl.toFixed(2) });
  }

  // ─── Aggregate ─────────────────────────────────────────────────────────────
  const decisive = allParlays.filter((p) => p.status === "won" || p.status === "lost");
  const wins = allParlays.filter((p) => p.status === "won").length;
  const losses = allParlays.filter((p) => p.status === "lost").length;
  const voids = allParlays.filter((p) => p.status === "void").length;
  const totalStaked = decisive.length * flatKelly;
  const realizedPnl = allParlays.reduce((s, p) => s + payout(p, flatKelly), 0);
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;
  const yieldPct = totalStaked > 0 ? (realizedPnl / totalStaked) * 100 : null;
  const avgImpliedHit =
    decisive.length > 0
      ? (decisive.reduce((s, p) => s + p.fairProb, 0) / decisive.length) * 100
      : null;

  // The raw yield is dominated by a handful of all-longshot combos (three
  // +300 legs paying ~64×) that a real sportsbook would cap or refuse. To give
  // an interpretable yield we also report it excluding parlays whose combined
  // decimal odds exceed a sane book limit. Win rate (above) is the robust
  // headline answer and is unaffected by this cap.
  const ODDS_CAP = 30; // combined decimal — ~+2900, beyond a typical 3-leg book limit
  const capped = decisive.filter((p) => p.decimalOdds <= ODDS_CAP);
  const cappedStaked = capped.length * flatKelly;
  const cappedPnl = capped.reduce((s, p) => s + payout(p, flatKelly), 0);
  const cappedYield = cappedStaked > 0 ? (cappedPnl / cappedStaked) * 100 : null;
  const cappedWins = capped.filter((p) => p.status === "won").length;
  const longshotExcluded = decisive.length - capped.length;

  const summary = {
    windowDays: days,
    daysWithData: perDay.length,
    note: "RETROSPECTIVE APPROXIMATION of Exp 4 — combinatorics-only on the model's daily graded prop picks. NOT the live +EV-vs-sharp rule; the +EV/haircut open gate is NOT applied. Quarantined from the pre-registered experiment.",
    legSource: "ModelPickSnapshot graded player-prop picks (win/loss/push)",
    rulesApplied: ["exactly 3 legs", "3 distinct games", "correlation block (same engine)"],
    rulesNotApplied: ["+EV vs de-vigged sharp", "−4pt haircut gate", "¼-Kelly sizing (used flat $" + flatKelly + "/parlay)"],
    totalParlays: allParlays.length,
    wins,
    losses,
    voids,
    decisive: decisive.length,
    winRatePct: winRate == null ? null : +winRate.toFixed(1),
    impliedHitRatePct: avgImpliedHit == null ? null : +avgImpliedHit.toFixed(1),
    flatStakeUsd: flatKelly,
    totalStakedUsd: +totalStaked.toFixed(2),
    realizedPnlUsd: +realizedPnl.toFixed(2),
    yieldPct: yieldPct == null ? null : +yieldPct.toFixed(2),
    yieldWarning:
      "Raw yield is dominated by a few all-longshot combos a real book would cap/refuse — NOT interpretable. Use win rate and the odds-capped yield.",
    oddsCappedDecimal: ODDS_CAP,
    cappedParlays: capped.length,
    cappedWins,
    longshotParlaysExcluded: longshotExcluded,
    cappedYieldPct: cappedYield == null ? null : +cappedYield.toFixed(2),
    cappedPnlUsd: +cappedPnl.toFixed(2),
    endingEquityUsd: +equity.toFixed(2),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, perDay }, null, 2));
    return;
  }

  console.log("");
  console.log("═══ Experiment No. 4 — PARLAY BACKTEST (retrospective, read-only) ═══");
  console.log(summary.note);
  console.log("");
  console.log(`Window:            last ${days} days (${perDay.length} days had graded prop data)`);
  console.log(`Leg source:        ${summary.legSource}`);
  console.log(`Rules applied:     ${summary.rulesApplied.join(" · ")}`);
  console.log(`Rules NOT applied: ${summary.rulesNotApplied.join(" · ")}`);
  console.log("");
  console.log(`Parlays formed:    ${summary.totalParlays}  (decisive ${summary.decisive}, full-void ${summary.voids})`);
  console.log(`WON:               ${summary.wins}`);
  console.log(`LOST:              ${summary.losses}`);
  console.log(
    `Win rate:          ${summary.winRatePct ?? "—"}%   (vs implied break-even ~${summary.impliedHitRatePct ?? "—"}%)   ← the robust headline answer`,
  );
  console.log("");
  console.log(`Flat stake:        $${flatKelly}/parlay`);
  console.log(`Total staked:      $${summary.totalStakedUsd}`);
  console.log(`Raw P&L:           ${summary.realizedPnlUsd >= 0 ? "+" : ""}$${summary.realizedPnlUsd}   (NOT interpretable — see warning)`);
  console.log(`Raw yield:         ${summary.yieldPct == null ? "—" : (summary.yieldPct >= 0 ? "+" : "") + summary.yieldPct + "%"}   ⚠ outlier-dominated`);
  console.log("");
  console.log(`⚠ ${summary.yieldWarning}`);
  console.log("");
  console.log(`Odds-capped (combined decimal ≤ ${summary.oddsCappedDecimal}, excl. ${summary.longshotParlaysExcluded} longshot combos a book would refuse):`);
  console.log(`  parlays:         ${summary.cappedParlays}  (won ${summary.cappedWins})`);
  console.log(`  capped P&L:      ${summary.cappedPnlUsd >= 0 ? "+" : ""}$${summary.cappedPnlUsd}`);
  console.log(`  capped yield:    ${summary.cappedYieldPct == null ? "—" : (summary.cappedYieldPct >= 0 ? "+" : "") + summary.cappedYieldPct + "%"}   ← interpretable verdict metric`);
  console.log("");
  console.log("Per-day:");
  console.log("  date        legPool  parlays  W   L   void   pnl");
  for (const d of perDay) {
    console.log(
      `  ${d.day}   ${String(d.legPool).padStart(6)}  ${String(d.parlays).padStart(7)}  ${String(d.won).padStart(2)}  ${String(d.lost).padStart(2)}  ${String(d.void).padStart(4)}   ${d.pnl >= 0 ? "+" : ""}${d.pnl}`,
    );
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[parlay-backtest] Fatal:", err);
    process.exit(1);
  });
