// quant-desk/engine.ts — the DETERMINISTIC core of THE QUANT DESK.
//
// Pure functions, no I/O. Decisions (scan → filter → size) are separated from
// effects (settle reads ESPN, book read/write) which live in the runner. This
// is the Hickey discipline: the whole edge logic below is unit-testable with no
// mocks because it takes plain data and returns plain data.
//
// The four steps the doctrine demands:
//   1. fair-value bus      — supplied by the adapter as FairValue[]
//   2. mispricing scanner  — edge = modelFair − devigMarketProb; keep ≥ floor
//                            AND model agrees-in-direction with the sharp line
//   3. sizing              — ¼-Kelly · per-bet cap · drawdown rail
//   4. ledger + CLV        — accounting DERIVED from rows; headline = CLV
//
// Reuses the proven devig math (americanToDecimal / kellyFraction / probToAmerican
// / americanToImpliedProb) rather than re-deriving it.

import {
  americanToDecimal,
  americanToImpliedProb,
  kellyFraction,
  probToAmerican,
} from "../devig";
import type {
  FairValue,
  LedgerSnapshot,
  MarketLine,
  Opportunity,
  QuantBet,
  QuantBook,
  Sport,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Config — the desk's risk doctrine, in one place.
// ─────────────────────────────────────────────────────────────────────────────

export interface QuantDeskConfig {
  startingBankrollUsd: number;
  /** PLAY only when edge = modelFair − devigMarketProb ≥ this. */
  edgeFloor: number;
  /** EV so far above floor it's almost certainly a data artifact — quarantine. */
  edgeCeiling: number;
  /** Fractional Kelly multiplier (¼ = the conservative model-bet standard). */
  kellyMultiplier: number;
  /** Cap any single bet at this fraction of current equity. */
  maxStakePctEquity: number;
  /** Skip ALL opens while equity sits below start·(1−maxDrawdown): the rail. */
  maxDrawdown: number;
  minStakeUsd: number;
}

export const QUANT_DESK_CONFIG: QuantDeskConfig = {
  startingBankrollUsd: 10_000,
  edgeFloor: 0.03,        // 3% model-vs-market mispricing, per the spec
  edgeCeiling: 0.20,      // > 20% edge = almost certainly a mismatch/artifact
  kellyMultiplier: 0.25,  // quarter-Kelly
  maxStakePctEquity: 0.02, // ≈2% of book per bet (the spec's per-bet cap)
  maxDrawdown: 0.20,      // pull the handbrake at −20% from start
  minStakeUsd: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — the mispricing scanner (pure).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Join FairValues to MarketLines by key and compute edge for each. Direction
 * agreement is NOT enforced here (that's a play-gate, applied in `playable`),
 * so the full opportunity set is inspectable. One Opportunity per matched key.
 */
export function scan(
  sport: Sport,
  game: { gameId: string; matchup: string; commenceTime: string },
  fairs: FairValue[],
  lines: MarketLine[],
): Opportunity[] {
  const lineByKey = new Map(lines.map((l) => [l.key, l]));
  const out: Opportunity[] = [];
  for (const fair of fairs) {
    const line = lineByKey.get(fair.key);
    if (!line) continue;
    if (
      !Number.isFinite(fair.modelFairProb) ||
      !Number.isFinite(line.devigMarketProb)
    ) {
      continue;
    }
    out.push({
      sport,
      gameId: game.gameId,
      matchup: game.matchup,
      commenceTime: game.commenceTime,
      fair,
      line,
      edge: +(fair.modelFairProb - line.devigMarketProb).toFixed(4),
    });
  }
  return out;
}

/**
 * Is this opportunity a PLAY? The doctrine's two gates:
 *   (a) edge in [floor, ceiling] — a real, non-artifact mispricing, AND
 *   (b) the model AGREES IN DIRECTION with the sharp line: we only take the side
 *       the sharp market also makes more-likely-than-not. We are buying a better
 *       PRICE on the sharp's own favored side, not fading the sharp. This is the
 *       core retail edge (Miller–Davidow) and it guards against a soft mispricing
 *       the sharp has already corrected against us.
 *
 * Returns a reason string when NOT playable (for transparent reporting), else null.
 */
export function rejectReason(
  opp: Opportunity,
  cfg: QuantDeskConfig = QUANT_DESK_CONFIG,
): string | null {
  if (opp.edge < cfg.edgeFloor) return `edge ${pct(opp.edge)} < floor ${pct(cfg.edgeFloor)}`;
  if (opp.edge > cfg.edgeCeiling)
    return `edge ${pct(opp.edge)} > ceiling ${pct(cfg.edgeCeiling)} (suspected artifact)`;
  // Direction agreement: the price we take must be on the sharp-favored side.
  if (!opp.line.sharpFavorsThis)
    return "model disagrees with sharp direction (would fade the sharp line)";
  return null;
}

export function isPlayable(opp: Opportunity, cfg: QuantDeskConfig = QUANT_DESK_CONFIG): boolean {
  return rejectReason(opp, cfg) === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 (accounting) — stats DERIVED from bet rows. No running cash balance.
// ─────────────────────────────────────────────────────────────────────────────

export interface QuantStats {
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
  yieldPct: number | null;
  avgEdge: number | null;
  // CLV — the HEADLINE.
  clvSettledCount: number;       // settled bets with a computed CLV
  clvBeatRatePct: number | null; // % of settled bets that beat the close
  avgClvCents: number | null;    // mean clvCents across settled bets
  peakEquityUsd: number;
  drawdownPct: number;           // current drawdown from peak (0.05 = −5%)
}

export function computeStats(book: QuantBook, cfg: QuantDeskConfig = QUANT_DESK_CONFIG): QuantStats {
  const open = book.bets.filter((b) => b.status === "open");
  const settled = book.bets.filter((b) => b.status !== "open");
  const realizedPnlUsd = settled.reduce((s, b) => s + (b.pnlUsd ?? 0), 0);
  const exposureUsd = open.reduce((s, b) => s + b.stakeUsd, 0);
  const equityUsd = cfg.startingBankrollUsd + realizedPnlUsd;
  const wins = settled.filter((b) => b.status === "won").length;
  const losses = settled.filter((b) => b.status === "lost").length;
  const pushes = settled.filter((b) => b.status === "void").length;
  const decisive = settled.filter((b) => b.status === "won" || b.status === "lost");
  const totalStakedUsd = decisive.reduce((s, b) => s + b.stakeUsd, 0);

  const edges = book.bets.map((b) => b.edge).filter((v) => Number.isFinite(v));

  // CLV across settled bets that carry a finite clvCents / beatClose.
  const clvBets = settled.filter((b) => b.clvCents != null && b.beatClose != null);
  const clvBeats = clvBets.filter((b) => b.beatClose === true).length;
  const clvSum = clvBets.reduce((s, b) => s + (b.clvCents ?? 0), 0);

  // Peak equity from the ledger (equity is monotone in realized P&L only at
  // settle ticks; peak over the ledger is the honest high-water mark).
  const peakEquityUsd = Math.max(
    cfg.startingBankrollUsd,
    ...book.ledger.map((l) => l.equityUsd),
    equityUsd,
  );
  const drawdownPct = peakEquityUsd > 0 ? Math.max(0, (peakEquityUsd - equityUsd) / peakEquityUsd) : 0;

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
    avgEdge: edges.length ? +(edges.reduce((s, v) => s + v, 0) / edges.length).toFixed(4) : null,
    clvSettledCount: clvBets.length,
    clvBeatRatePct: clvBets.length ? +((clvBeats / clvBets.length) * 100).toFixed(1) : null,
    avgClvCents: clvBets.length ? +(clvSum / clvBets.length).toFixed(2) : null,
    peakEquityUsd: +peakEquityUsd.toFixed(2),
    drawdownPct: +drawdownPct.toFixed(4),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — sizing (¼-Kelly · per-bet cap · drawdown rail).
// ─────────────────────────────────────────────────────────────────────────────

/** ¼-Kelly stake in USD vs current equity, clamped to the per-bet cap and
 *  floored. Returns 0 when there's no edge or it's too small to bother. */
export function stakeFor(
  modelFairProb: number,
  priceAmerican: number,
  equityUsd: number,
  cfg: QuantDeskConfig = QUANT_DESK_CONFIG,
): number {
  const frac = kellyFraction(modelFairProb, priceAmerican, cfg.kellyMultiplier);
  if (frac <= 0) return 0;
  const raw = frac * equityUsd;
  const capped = Math.min(raw, cfg.maxStakePctEquity * equityUsd);
  if (capped < cfg.minStakeUsd) return 0;
  return +capped.toFixed(2);
}

/** The drawdown rail: true ⇒ we are below the equity floor and must NOT open new
 *  bets (only let open bets ride + settle). start·(1−maxDrawdown). */
export function drawdownBreached(stats: QuantStats, cfg: QuantDeskConfig = QUANT_DESK_CONFIG): boolean {
  return stats.equityUsd < cfg.startingBankrollUsd * (1 - cfg.maxDrawdown);
}

// ─────────────────────────────────────────────────────────────────────────────
// Open — book a paper bet for each playable, not-yet-held opportunity.
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenResult {
  opened: number;
  skippedHeld: number;
  skippedUnplayable: number;
  skippedSizing: number;
  skippedStarted: number;
  railActive: boolean;
}

export function openFromOpportunities(
  book: QuantBook,
  opps: Opportunity[],
  nowMs: number,
  cfg: QuantDeskConfig = QUANT_DESK_CONFIG,
): OpenResult {
  const held = new Set(book.bets.map((b) => b.id));
  const stats = computeStats(book, cfg);
  const railActive = drawdownBreached(stats, cfg);
  const res: OpenResult = {
    opened: 0,
    skippedHeld: 0,
    skippedUnplayable: 0,
    skippedSizing: 0,
    skippedStarted: 0,
    railActive,
  };
  if (railActive) return res; // handbrake: settle-only this cycle

  const nowIso = new Date(nowMs).toISOString();
  for (const opp of opps) {
    const id = betId(opp.sport, opp.gameId, opp.fair.key);
    if (held.has(id)) {
      res.skippedHeld++;
      continue;
    }
    if (!isPlayable(opp, cfg)) {
      res.skippedUnplayable++;
      continue;
    }
    // Only bet a game that hasn't started — a paper bet on a live/finished game
    // isn't a bet we could actually have placed at the entry price.
    const commenceMs = new Date(opp.commenceTime).getTime();
    if (!Number.isFinite(commenceMs) || nowMs >= commenceMs) {
      res.skippedStarted++;
      continue;
    }
    const stake = stakeFor(opp.fair.modelFairProb, opp.line.priceAmerican, stats.equityUsd, cfg);
    if (stake <= 0) {
      res.skippedSizing++;
      continue;
    }
    const closeFairAmerican = probToAmerican(opp.line.devigMarketProb);
    book.bets.push({
      id,
      sport: opp.sport,
      gameId: opp.gameId,
      matchup: opp.matchup,
      market: opp.fair.market,
      selection: opp.fair.selection,
      commenceTime: opp.commenceTime,
      entryAt: nowIso,
      priceAmerican: opp.line.priceAmerican,
      book: opp.line.book,
      modelFairProb: +opp.fair.modelFairProb.toFixed(4),
      devigMarketProb: +opp.line.devigMarketProb.toFixed(4),
      edge: opp.edge,
      stakeUsd: stake,
      estimate: opp.fair.estimate,
      closeAt: nowIso,
      closeDevigMarketProb: +opp.line.devigMarketProb.toFixed(4),
      closeFairAmerican: Number.isFinite(closeFairAmerican) ? closeFairAmerican : NaN,
      clvCents: null,
      beatClose: null,
      status: "open",
      finalScore: null,
      pnlUsd: null,
      settledAt: null,
    });
    held.add(id);
    res.opened++;
  }
  return res;
}

/** Refresh the CLOSE on every open, pre-commence bet with the latest sharp
 *  de-vigged fair. The last refresh before commence is the close we grade CLV
 *  against. Pure: mutates the book's open bets from a key→devigMarketProb map. */
export function refreshCloses(
  book: QuantBook,
  closesByBetId: Map<string, number>,
  nowMs: number,
): number {
  const nowIso = new Date(nowMs).toISOString();
  let refreshed = 0;
  for (const bet of book.bets) {
    if (bet.status !== "open") continue;
    const commenceMs = new Date(bet.commenceTime).getTime();
    if (Number.isFinite(commenceMs) && nowMs >= commenceMs) continue; // game live — close is locked
    const latest = closesByBetId.get(bet.id);
    if (latest == null || !Number.isFinite(latest)) continue;
    bet.closeAt = nowIso;
    bet.closeDevigMarketProb = +latest.toFixed(4);
    const am = probToAmerican(latest);
    bet.closeFairAmerican = Number.isFinite(am) ? am : NaN;
    refreshed++;
  }
  return refreshed;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLV settle (pure) — finalize the closing-line value once a bet is decided.
// ─────────────────────────────────────────────────────────────────────────────

/** Compute CLV fields for a bet from its locked entry price vs the close fair.
 *  beatClose = the price we took implies a LOWER probability than the sharp
 *  closing fair → we bought a better number than the market settled on. */
export function finalizeClv(bet: QuantBet): void {
  const entryImplied = americanToImpliedProb(bet.priceAmerican);
  const closeFairAmerican = Number.isFinite(bet.closeFairAmerican)
    ? bet.closeFairAmerican
    : probToAmerican(bet.closeDevigMarketProb);
  bet.clvCents = Number.isFinite(closeFairAmerican)
    ? +(bet.priceAmerican - closeFairAmerican).toFixed(1)
    : null;
  bet.beatClose = Number.isFinite(entryImplied)
    ? entryImplied < bet.closeDevigMarketProb
    : null;
}

/** Apply a decided outcome ("won"|"lost"|"void") to an open bet: P&L from the
 *  taken price, CLV finalized, status flipped. Pure. */
export function settleBet(
  bet: QuantBet,
  result: "won" | "lost" | "void",
  finalScore: string | null,
  nowMs: number,
): void {
  const dec = americanToDecimal(bet.priceAmerican);
  bet.pnlUsd =
    result === "won"
      ? +(bet.stakeUsd * (dec - 1)).toFixed(2)
      : result === "lost"
        ? +(-bet.stakeUsd).toFixed(2)
        : 0; // void → stake returned
  bet.status = result;
  bet.finalScore = finalScore;
  bet.settledAt = new Date(nowMs).toISOString();
  finalizeClv(bet);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger snapshot.
// ─────────────────────────────────────────────────────────────────────────────

export function writeSnapshot(book: QuantBook, nowIso: string, cfg: QuantDeskConfig = QUANT_DESK_CONFIG): QuantStats {
  const s = computeStats(book, cfg);
  const snap: LedgerSnapshot = {
    ts: nowIso,
    equityUsd: s.equityUsd,
    realizedPnlUsd: s.realizedPnlUsd,
    exposureUsd: s.exposureUsd,
    openCount: s.openCount,
    settledCount: s.settledCount,
    wins: s.wins,
    losses: s.losses,
    drawdownPct: s.drawdownPct,
  };
  book.ledger.push(snap);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

export function betId(sport: Sport, gameId: string, fairKey: string): string {
  return `${sport}|${gameId}|${fairKey}`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
