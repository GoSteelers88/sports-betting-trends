// devig-paper.ts — paper-trading book for the de-vigged-sharp +EV picks.
//
// Repurposes the Kalshi paper-engine pattern (open → settle → ledger snapshot,
// accounting DERIVED from bet rows so cash can't drift) but points it at the
// live thesis instead of the debunked favorite-longshot one:
//
//   Bet source — the `wouldBet` entries the CLV-proof harness already logs
//   (clv-proof-log.json): a soft-book price that beat the de-vigged Pinnacle
//   fair value by ≥ the EV floor, captured EARLY at a locked entry price. So
//   simulated P&L ties directly to the signal the CLV harness measures.
//
//   Fill model — we take the best soft price recorded at entry (the price we'd
//   actually have gotten), staked at quarter-Kelly on the de-vigged fair prob.
//   No adverse selection problem here: these are taker bets at a posted price,
//   not resting maker fills, so (unlike the Kalshi book) the fill is real.
//
//   Settlement — actual game result via ESPN finals (src/lib/espn-finals.ts).
//
// JSON-backed (data/processed/devig-paper-book.json), no DB / no migration —
// same storage pattern as the CLV-proof log it feeds from.

import fs from "node:fs";
import path from "node:path";
import { americanToDecimal, kellyFraction } from "./devig";
import { loadStore as loadClvStore, type ClvProofEntry } from "./clv-proof";
import {
  fetchFinalsAround,
  findFinalForMatchup,
  gradeMoneyline,
  type FinalsLeague,
  type GameFinal,
} from "./espn-finals";

export const DEVIG_PAPER_CONFIG = {
  startingBankrollUsd: 10_000,
  evFloor: 0.02, // only bet +EV ≥ 2% vs de-vigged sharp (matches wouldBet)
  kellyMultiplier: 0.25, // quarter-Kelly — the conservative model-bet standard
  maxStakePctEquity: 0.05, // cap any one bet at 5% of equity
  minStakeUsd: 10,
  leagues: ["MLB", "NBA"] as FinalsLeague[],
};

export type DevigPaperBet = {
  id: string; // = the CLV-proof entry id (league|day|pair|side)
  league: string;
  matchup: string;
  team: string;
  side: "home" | "away";
  commenceTime: string;
  // entry (locked at open)
  entryAt: string;
  oddsAmerican: number; // the best soft price we took
  book: string; // which soft book
  fairProb: number; // de-vigged Pinnacle fair prob for this side
  evVsSharp: number; // EV% at entry vs the sharp line
  stakeUsd: number;
  // settlement
  status: "open" | "won" | "lost" | "void";
  finalScore: string | null;
  pnlUsd: number | null;
  settledAt: string | null;
};

export type DevigPaperBook = {
  updatedAt: string;
  bets: DevigPaperBet[];
  ledger: Array<{
    ts: string;
    equityUsd: number;
    realizedPnlUsd: number;
    exposureUsd: number;
    openCount: number;
    settledCount: number;
    wins: number;
    losses: number;
  }>;
};

export type DevigPaperStats = {
  startingBankrollUsd: number;
  equityUsd: number;
  cashUsd: number;
  exposureUsd: number;
  realizedPnlUsd: number;
  roiPct: number;
  openCount: number;
  settledCount: number;
  wins: number;
  losses: number;
  pushes: number;
  winRatePct: number | null;
  totalStakedUsd: number;
  yieldPct: number | null; // realized P&L as % of total staked (betting ROI)
  avgEvVsSharp: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Store I/O
// ─────────────────────────────────────────────────────────────────────────────

function bookPath(dir: string): string {
  return path.join(dir, "devig-paper-book.json");
}

export function loadBook(dir: string): DevigPaperBook {
  const p = bookPath(dir);
  if (!fs.existsSync(p)) return { updatedAt: "", bets: [], ledger: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as DevigPaperBook;
    return {
      updatedAt: raw.updatedAt ?? "",
      bets: raw.bets ?? [],
      ledger: raw.ledger ?? [],
    };
  } catch {
    return { updatedAt: "", bets: [], ledger: [] };
  }
}

export function saveBook(dir: string, book: DevigPaperBook, nowIso: string): void {
  fs.writeFileSync(
    bookPath(dir),
    JSON.stringify({ ...book, updatedAt: nowIso }, null, 2),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounting — DERIVED from bet rows (no running cash that can drift)
// ─────────────────────────────────────────────────────────────────────────────

export function computeStats(book: DevigPaperBook): DevigPaperStats {
  const cfg = DEVIG_PAPER_CONFIG;
  const open = book.bets.filter((b) => b.status === "open");
  const settled = book.bets.filter((b) => b.status !== "open");
  const realizedPnlUsd = settled.reduce((s, b) => s + (b.pnlUsd ?? 0), 0);
  const exposureUsd = open.reduce((s, b) => s + b.stakeUsd, 0);
  const equityUsd = cfg.startingBankrollUsd + realizedPnlUsd;
  const wins = settled.filter((b) => b.status === "won").length;
  const losses = settled.filter((b) => b.status === "lost").length;
  const pushes = settled.filter((b) => b.status === "void").length;
  // Total staked only counts decisive (won/lost) bets — voids are returned.
  const decisive = settled.filter((b) => b.status === "won" || b.status === "lost");
  const totalStakedUsd = decisive.reduce((s, b) => s + b.stakeUsd, 0);
  const evVals = book.bets.map((b) => b.evVsSharp).filter((v) => Number.isFinite(v));
  return {
    startingBankrollUsd: cfg.startingBankrollUsd,
    equityUsd: +equityUsd.toFixed(2),
    cashUsd: +(equityUsd - exposureUsd).toFixed(2),
    exposureUsd: +exposureUsd.toFixed(2),
    realizedPnlUsd: +realizedPnlUsd.toFixed(2),
    roiPct: +((realizedPnlUsd / cfg.startingBankrollUsd) * 100).toFixed(2),
    openCount: open.length,
    settledCount: settled.length,
    wins,
    losses,
    pushes,
    winRatePct: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : null,
    totalStakedUsd: +totalStakedUsd.toFixed(2),
    yieldPct: totalStakedUsd > 0 ? +((realizedPnlUsd / totalStakedUsd) * 100).toFixed(2) : null,
    avgEvVsSharp: evVals.length ? +(evVals.reduce((s, v) => s + v, 0) / evVals.length).toFixed(4) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Open — book a paper bet for each fresh +EV entry not already held
// ─────────────────────────────────────────────────────────────────────────────

/** Quarter-Kelly stake in USD against current equity, clamped + floored. */
export function stakeFor(
  fairProb: number,
  oddsAmerican: number,
  equityUsd: number,
): number {
  const cfg = DEVIG_PAPER_CONFIG;
  const frac = kellyFraction(fairProb, oddsAmerican, cfg.kellyMultiplier);
  if (frac <= 0) return 0;
  const raw = frac * equityUsd;
  const capped = Math.min(raw, cfg.maxStakePctEquity * equityUsd);
  if (capped < cfg.minStakeUsd) return 0; // too small to bother
  return +capped.toFixed(2);
}

export function openFromEntries(
  book: DevigPaperBook,
  entries: ClvProofEntry[],
  nowMs: number,
): { opened: number; skipped: number } {
  const cfg = DEVIG_PAPER_CONFIG;
  const held = new Set(book.bets.map((b) => b.id));
  let { equityUsd } = computeStats(book);
  let opened = 0;
  let skipped = 0;

  for (const e of entries) {
    if (held.has(e.id)) continue;
    if (!e.wouldBet) continue; // not a +EV play
    if (e.entryEvVsSharp < cfg.evFloor) continue;
    if (!cfg.leagues.includes(e.league as FinalsLeague)) continue;
    // Only bet a game that hasn't started — a paper bet on a live/finished game
    // isn't a bet we could actually have placed at the entry price.
    const commenceMs = new Date(e.commenceTime).getTime();
    if (!Number.isFinite(commenceMs) || nowMs >= commenceMs) {
      skipped++;
      continue;
    }
    const stakeUsd = stakeFor(e.entrySharpFairProb, e.entrySoftPrice, equityUsd);
    if (stakeUsd <= 0) {
      skipped++;
      continue;
    }
    book.bets.push({
      id: e.id,
      league: e.league,
      matchup: e.matchup,
      team: e.team,
      side: e.side,
      commenceTime: e.commenceTime,
      entryAt: e.entryAt,
      oddsAmerican: e.entrySoftPrice,
      book: e.entrySoftBook,
      fairProb: e.entrySharpFairProb,
      evVsSharp: e.entryEvVsSharp,
      stakeUsd,
      status: "open",
      finalScore: null,
      pnlUsd: null,
      settledAt: null,
    });
    held.add(e.id);
    equityUsd -= 0; // stake is exposure, not realized — equity unchanged at open
    opened++;
  }
  return { opened, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Settle — grade open bets whose games have finished, against ESPN finals
// ─────────────────────────────────────────────────────────────────────────────

export function settleBets(
  book: DevigPaperBook,
  finalsByLeague: Map<string, GameFinal[]>,
  nowMs: number,
): number {
  let settled = 0;
  for (const bet of book.bets) {
    if (bet.status !== "open") continue;
    const commenceMs = new Date(bet.commenceTime).getTime();
    if (Number.isFinite(commenceMs) && nowMs < commenceMs) continue; // not started
    const finals = finalsByLeague.get(bet.league) ?? [];
    const final = findFinalForMatchup(bet.matchup, bet.team, commenceMs, finals);
    if (!final) continue; // not final yet (or no score available)
    const result = gradeMoneyline(bet.team, final);
    if (!result) continue;
    const dec = americanToDecimal(bet.oddsAmerican);
    bet.pnlUsd =
      result === "won"
        ? +(bet.stakeUsd * (dec - 1)).toFixed(2)
        : result === "lost"
          ? +(-bet.stakeUsd).toFixed(2)
          : 0; // void → stake returned
    bet.status = result;
    bet.finalScore = `${final.awayTeam} ${final.awayScore} @ ${final.homeTeam} ${final.homeScore}`;
    bet.settledAt = new Date(nowMs).toISOString();
    settled++;
  }
  return settled;
}

export function writeSnapshot(book: DevigPaperBook, nowIso: string): DevigPaperStats {
  const s = computeStats(book);
  book.ledger.push({
    ts: nowIso,
    equityUsd: s.equityUsd,
    realizedPnlUsd: s.realizedPnlUsd,
    exposureUsd: s.exposureUsd,
    openCount: s.openCount,
    settledCount: s.settledCount,
    wins: s.wins,
    losses: s.losses,
  });
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// One full cycle (impure: reads CLV log + ESPN, writes book)
// ─────────────────────────────────────────────────────────────────────────────

export async function runDevigPaperCycle(
  opts: { dataDir?: string; nowMs?: number } = {},
): Promise<{
  opened: number;
  settled: number;
  skipped: number;
  stats: DevigPaperStats;
}> {
  const dir = opts.dataDir ?? path.join(process.cwd(), "data", "processed");
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const book = loadBook(dir);

  // 1) settle first (free up nothing here, but realizes P&L before sizing new bets)
  const openBets = book.bets.filter((b) => b.status === "open");
  const finalsByLeague = new Map<string, GameFinal[]>();
  if (openBets.length > 0) {
    const leagues = new Set(openBets.map((b) => b.league));
    for (const lg of leagues) {
      if (!DEVIG_PAPER_CONFIG.leagues.includes(lg as FinalsLeague)) continue;
      finalsByLeague.set(lg, await fetchFinalsAround(lg as FinalsLeague, new Date(nowMs)));
    }
  }
  const settled = settleBets(book, finalsByLeague, nowMs);

  // 2) open new +EV plays from the CLV-proof log
  const clv = loadClvStore(dir);
  const { opened, skipped } = openFromEntries(book, clv.entries, nowMs);

  // 3) snapshot
  const stats = writeSnapshot(book, nowIso);
  saveBook(dir, book, nowIso);

  return { opened, settled, skipped, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only view for a dashboard (same shape spirit as the Kalshi ledger view)
// ─────────────────────────────────────────────────────────────────────────────

export function getDevigLedgerView(dir = path.join(process.cwd(), "data", "processed")) {
  const book = loadBook(dir);
  const stats = computeStats(book);
  return {
    stats,
    config: {
      evFloor: DEVIG_PAPER_CONFIG.evFloor,
      kellyMultiplier: DEVIG_PAPER_CONFIG.kellyMultiplier,
      leagues: DEVIG_PAPER_CONFIG.leagues,
    },
    open: book.bets
      .filter((b) => b.status === "open")
      .sort((a, b) => a.commenceTime.localeCompare(b.commenceTime)),
    settled: book.bets
      .filter((b) => b.status !== "open")
      .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""))
      .slice(0, 100),
    equityCurve: book.ledger.slice(-200),
    generatedAt: new Date().toISOString(),
  };
}
