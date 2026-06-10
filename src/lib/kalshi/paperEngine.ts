/**
 * paperEngine.ts — favorite-longshot paper trading engine ($10k virtual book).
 *
 * Strategy (grounded in Bürgi/Deng/Whelan 2026 + Le 2026): the crowd overpays
 * for longshots and underpays for heavy favorites. We harvest the favorite side
 * as a MAKER (rest at the bid → ~zero fees), diversified across many uncorrelated
 * non-sports markets, hold to settlement.
 *
 * Accounting is DERIVED from position rows every cycle (no running cash that can
 * drift): equity = startingBankroll + realizedPnl; cash = equity − openExposure.
 * Open positions are held at cost until settlement (no mark-to-market noise).
 *
 * Fill model (honest, conservative): we assume a resting limit at the current
 * yes_bid fills. Entry price = yesBid. This is conservative on price (we pay the
 * bid, not the ask) but optimistic on fill probability — surfaced on the site.
 */
import { prisma } from "@/lib/prisma";
import { fetchOpenMarkets, fetchMarketStates, type KalshiMarket } from "@/lib/kalshi/marketData";

export const PAPER_CONFIG = {
  startingBankrollUsd: 10_000,
  minAsk: 0.8, // favorite floor (research: >0.80 outperforms)
  maxAsk: 0.95, // skip near-certain (thin edge, price precision)
  minVolume: 500, // liquidity gate (volume_fp) so a maker fill is plausible
  minOpenInterest: 500,
  maxSpread: 0.04, // skip wide-spread markets — a bid-fill there isn't realistic
  maxHorizonDays: 60, // resolve within this window → turnover for a live tracker
  targetPerPositionUsd: 200,
  maxConcurrentPositions: 50,
  maxPerCategory: 12,
  excludeCategories: ["Sports"] as string[], // efficient end — edge is non-sports
  fillAtBid: true,
};

export interface PaperStats {
  startingBankrollUsd: number;
  equityUsd: number;
  cashUsd: number;
  exposureUsd: number;
  realizedPnlUsd: number;
  roiPct: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Derive all account stats from the position rows. */
export async function computeStats(): Promise<PaperStats> {
  const positions = await prisma.kalshiPaperPosition.findMany();
  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status === "closed");
  const realizedPnlUsd = closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const exposureUsd = open.reduce((s, p) => s + p.costUsd, 0);
  const equityUsd = PAPER_CONFIG.startingBankrollUsd + realizedPnlUsd;
  const cashUsd = equityUsd - exposureUsd;
  const wins = closed.filter((p) => p.result === "yes").length;
  const losses = closed.filter((p) => p.result === "no").length;
  return {
    startingBankrollUsd: PAPER_CONFIG.startingBankrollUsd,
    equityUsd,
    cashUsd,
    exposureUsd,
    realizedPnlUsd,
    roiPct: (realizedPnlUsd / PAPER_CONFIG.startingBankrollUsd) * 100,
    openCount: open.length,
    closedCount: closed.length,
    wins,
    losses,
    winRatePct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
  };
}

/** Settle any open positions whose markets have resolved. Returns count closed. */
export async function settleOpenPositions(): Promise<number> {
  const open = await prisma.kalshiPaperPosition.findMany({ where: { status: "open" } });
  if (open.length === 0) return 0;
  const states = await fetchMarketStates(open.map((p) => p.ticker));
  let closed = 0;
  for (const pos of open) {
    const st = states.get(pos.ticker);
    if (!st || !st.result) continue; // not resolved yet
    // We bought YES: payout $1/contract if result === "yes", else $0.
    const payoutUsd = (st.result === "yes" ? 1 : 0) * pos.contracts;
    const pnlUsd = payoutUsd - pos.costUsd;
    await prisma.kalshiPaperPosition.update({
      where: { id: pos.id },
      data: { status: "closed", result: st.result, pnlUsd, closedAt: isoNow() },
    });
    closed++;
  }
  return closed;
}

/** Screen open markets for favorite-longshot entries and open paper positions. */
export async function openNewPositions(): Promise<{ opened: number; scanned: number }> {
  const cfg = PAPER_CONFIG;
  const stats = await computeStats();

  // Capacity / cash available right now
  let slots = cfg.maxConcurrentPositions - stats.openCount;
  let cashAvail = stats.cashUsd;
  if (slots <= 0 || cashAvail < 1) return { opened: 0, scanned: 0 };

  const existing = await prisma.kalshiPaperPosition.findMany({ select: { ticker: true, category: true, status: true } });
  const heldTickers = new Set(existing.map((p) => p.ticker)); // never re-enter a market (open or closed)
  const perCat: Record<string, number> = {};
  for (const p of existing) if (p.status === "open") perCat[p.category] = (perCat[p.category] ?? 0) + 1;

  const markets = await fetchOpenMarkets();
  const now = Date.now();
  const horizonMs = cfg.maxHorizonDays * 24 * 60 * 60 * 1000;

  // Candidate filter
  const candidates = markets.filter((m) => {
    if (heldTickers.has(m.ticker)) return false;
    if (cfg.excludeCategories.includes(m.category)) return false;
    if (m.yesAsk < cfg.minAsk || m.yesAsk > cfg.maxAsk) return false;
    if (m.yesAsk - m.yesBid > cfg.maxSpread) return false; // tight markets only (realistic maker fill)
    if (m.volume < cfg.minVolume && m.openInterest < cfg.minOpenInterest) return false;
    const close = Date.parse(m.closeTime);
    if (!Number.isFinite(close)) return false;
    if (close <= now) return false; // already closing
    if (close - now > horizonMs) return false; // too far out
    return true;
  });

  // Rank: prefer the cleanest favorites — highest liquidity, then closest to the
  // 0.80–0.90 sweet spot where the documented edge is richest after fees.
  const sweet = (m: KalshiMarket) => -Math.abs(m.yesAsk - 0.85);
  candidates.sort((a, b) => b.volume - a.volume || sweet(b) - sweet(a));

  let opened = 0;
  for (const m of candidates) {
    if (slots <= 0) break;
    if ((perCat[m.category] ?? 0) >= cfg.maxPerCategory) continue;

    const entryPrice = cfg.fillAtBid ? m.yesBid : m.yesAsk;
    if (entryPrice <= 0 || entryPrice >= 1) continue;
    const contracts = Math.max(1, Math.floor(cfg.targetPerPositionUsd / entryPrice));
    const costUsd = +(contracts * entryPrice).toFixed(2);
    if (costUsd > cashAvail) continue; // not enough virtual cash

    try {
      await prisma.kalshiPaperPosition.create({
        data: {
          ticker: m.ticker,
          eventTicker: m.eventTicker,
          category: m.category,
          title: m.title.slice(0, 240),
          side: "yes",
          entryPrice,
          contracts,
          costUsd,
          status: "open",
          openedAt: isoNow(),
          closeTime: m.closeTime,
        },
      });
    } catch {
      continue; // unique-ticker race / already exists
    }
    heldTickers.add(m.ticker);
    perCat[m.category] = (perCat[m.category] ?? 0) + 1;
    cashAvail -= costUsd;
    slots--;
    opened++;
  }

  return { opened, scanned: markets.length };
}

/** Append a ledger snapshot (for the equity curve on the site). */
export async function writeSnapshot(): Promise<PaperStats> {
  const s = await computeStats();
  await prisma.kalshiPaperLedgerSnapshot.create({
    data: {
      ts: isoNow(),
      cashUsd: s.cashUsd,
      exposureUsd: s.exposureUsd,
      equityUsd: s.equityUsd,
      realizedPnlUsd: s.realizedPnlUsd,
      openCount: s.openCount,
      closedCount: s.closedCount,
      wins: s.wins,
      losses: s.losses,
    },
  });
  return s;
}

/** One full cycle: settle resolved positions → open new ones → snapshot. */
export async function runPaperCycle(): Promise<{
  settled: number;
  opened: number;
  scanned: number;
  stats: PaperStats;
}> {
  const settled = await settleOpenPositions();
  const { opened, scanned } = await openNewPositions();
  const stats = await writeSnapshot();
  return { settled, opened, scanned, stats };
}

export interface LedgerView {
  stats: PaperStats;
  config: { minAsk: number; maxAsk: number; maxHorizonDays: number; excludeCategories: string[] };
  open: Array<{
    ticker: string;
    category: string;
    title: string;
    entryPrice: number;
    contracts: number;
    costUsd: number;
    closeTime: string;
    openedAt: string;
  }>;
  closed: Array<{
    ticker: string;
    category: string;
    title: string;
    entryPrice: number;
    result: string | null;
    pnlUsd: number | null;
    closedAt: string | null;
  }>;
  equityCurve: Array<{ ts: string; equityUsd: number; realizedPnlUsd: number }>;
  generatedAt: string;
}

/** Read-only view for the dashboard (no Kalshi API calls — DB only). */
export async function getLedgerView(): Promise<LedgerView> {
  const stats = await computeStats();
  const [open, closed, snaps] = await Promise.all([
    prisma.kalshiPaperPosition.findMany({ where: { status: "open" }, orderBy: { closeTime: "asc" } }),
    prisma.kalshiPaperPosition.findMany({ where: { status: "closed" }, orderBy: { closedAt: "desc" }, take: 50 }),
    prisma.kalshiPaperLedgerSnapshot.findMany({ orderBy: { id: "desc" }, take: 200 }),
  ]);
  return {
    stats,
    config: {
      minAsk: PAPER_CONFIG.minAsk,
      maxAsk: PAPER_CONFIG.maxAsk,
      maxHorizonDays: PAPER_CONFIG.maxHorizonDays,
      excludeCategories: PAPER_CONFIG.excludeCategories,
    },
    open: open.map((p) => ({
      ticker: p.ticker,
      category: p.category,
      title: p.title,
      entryPrice: p.entryPrice,
      contracts: p.contracts,
      costUsd: p.costUsd,
      closeTime: p.closeTime,
      openedAt: p.openedAt,
    })),
    closed: closed.map((p) => ({
      ticker: p.ticker,
      category: p.category,
      title: p.title,
      entryPrice: p.entryPrice,
      result: p.result,
      pnlUsd: p.pnlUsd,
      closedAt: p.closedAt,
    })),
    equityCurve: snaps
      .reverse()
      .map((s) => ({ ts: s.ts, equityUsd: s.equityUsd, realizedPnlUsd: s.realizedPnlUsd })),
    generatedAt: isoNow(),
  };
}
