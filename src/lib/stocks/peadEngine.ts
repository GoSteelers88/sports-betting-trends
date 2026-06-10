/**
 * peadEngine.ts — Experiment No. 3: PEAD stock paper book ($10k virtual).
 *
 * Pre-registered rule: PEAD_PAPER_SPEC.md. Long extreme positive EPS
 * surprises ($500 each, max 20), hold 28 calendar days, exit at the next
 * cron, every leg benchmarked against SPY over the identical window.
 * Orders are simulated on Alpaca PAPER (taker market orders during RTH);
 * Turso is the book of record for dates, surprises, and benchmark legs.
 *
 * Accounting matches Experiment No. 1: positions at cost, equity =
 * $10k + realized P&L — the verdict metric is excess-vs-SPY, not the curve.
 */
import { prisma } from "@/lib/prisma";
import {
  PEAD_CONFIG,
  qualifies,
  calendarRange,
  exitDueISO,
  isExitDue,
  excessReturnPct,
  meanTStat,
  killVerdict,
  overnightLegs,
  type KillVerdict,
} from "@/lib/stocks/peadLogic";
import {
  alpacaConfigured,
  marketIsOpen,
  getAsset,
  latestTradePrice,
  avgDollarVolume,
  placeMarketOrder,
  waitForFill,
  getPositionQty,
  fetchDailyBars,
} from "@/lib/stocks/alpaca";
import { finnhubConfigured, earningsCalendar } from "@/lib/stocks/finnhub";

const isoNow = () => new Date().toISOString();

export interface StockPaperStats {
  bookUsd: number;
  equityUsd: number;
  cashUsd: number;
  exposureUsd: number;
  realizedPnlUsd: number;
  roiPct: number;
  openCount: number;
  closedCount: number;
  settledWithBenchmark: number;
  avgExcessRetPct: number | null;
  excessTStat: number | null;
  verdict: KillVerdict;
}

export async function computeStockStats(): Promise<StockPaperStats> {
  const positions = await prisma.stockPaperPosition.findMany();
  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status === "closed");
  const realizedPnlUsd = closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const exposureUsd = open.reduce((s, p) => s + p.costUsd, 0);
  const equityUsd = PEAD_CONFIG.bookUsd + realizedPnlUsd;
  const excess = closed
    .map((p) => p.excessRetPct)
    .filter((x): x is number => x != null && Number.isFinite(x));
  const { mean, t } = meanTStat(excess);
  return {
    bookUsd: PEAD_CONFIG.bookUsd,
    equityUsd,
    cashUsd: equityUsd - exposureUsd,
    exposureUsd,
    realizedPnlUsd,
    roiPct: (realizedPnlUsd / PEAD_CONFIG.bookUsd) * 100,
    openCount: open.length,
    closedCount: closed.length,
    settledWithBenchmark: excess.length,
    avgExcessRetPct: mean,
    excessTStat: t,
    verdict: killVerdict(excess),
  };
}

/** Close positions whose 28-day hold is up. Returns count settled. */
export async function settleDuePositions(now = new Date()): Promise<number> {
  const open = await prisma.stockPaperPosition.findMany({ where: { status: "open" } });
  const due = open.filter((p) => isExitDue(p.exitDue, now));
  let settled = 0;
  for (const p of due) {
    try {
      // Corporate actions can change the paper position — sell what's there,
      // never more than we booked.
      const held = await getPositionQty(p.symbol);
      const qty = held != null ? Math.min(p.qty, held) : p.qty;
      const order = await placeMarketOrder({ symbol: p.symbol, side: "sell", qty });
      const fill = await waitForFill(order.id);
      if (!fill) {
        console.warn(`[pead] exit order for ${p.symbol} did not fill — retrying next cycle`);
        continue;
      }
      const exitSpy = await latestTradePrice(PEAD_CONFIG.benchmarkSymbol);
      const pnlUsd = +(fill.qty * (fill.price - p.entryPrice)).toFixed(2);
      const excess = excessReturnPct(p.entryPrice, fill.price, p.entrySpy, exitSpy);
      // Overnight decomposition legs — fail-soft, verdict instrumentation only.
      let legs: { entryDayClose: number; nextOpen: number | null } | null = null;
      try {
        const barsEnd = new Date(Date.parse(p.openedAt) + 6 * 24 * 60 * 60 * 1000).toISOString();
        legs = overnightLegs(await fetchDailyBars(p.symbol, p.openedAt.slice(0, 10), barsEnd), p.openedAt);
      } catch {
        /* legs stay null */
      }
      await prisma.stockPaperPosition.update({
        where: { id: p.id },
        data: {
          status: "closed",
          exitPrice: fill.price,
          exitSpy,
          pnlUsd,
          excessRetPct: excess,
          closedAt: isoNow(),
          exitOrderId: order.id,
          entryDayClose: legs?.entryDayClose ?? null,
          nextOpen: legs?.nextOpen ?? null,
        },
      });
      settled++;
    } catch (err) {
      console.warn(`[pead] settle failed for ${p.symbol}: ${(err as Error).message}`);
    }
  }
  return settled;
}

/** Screen yesterday-AMC/today-BMO reports and open qualifying longs. */
export async function openNewPositions(
  now = new Date(),
): Promise<{ opened: number; scanned: number; qualified: number }> {
  const cfg = PEAD_CONFIG;
  const stats = await computeStockStats();
  let slots = cfg.maxConcurrent - stats.openCount;
  let cashAvail = stats.cashUsd;
  if (slots <= 0 || cashAvail < cfg.perPositionUsd) return { opened: 0, scanned: 0, qualified: 0 };

  const { from, to } = calendarRange(now);
  const reports = await earningsCalendar(from, to);
  const candidates = reports
    .map((r) => ({ r, q: qualifies(r) }))
    .filter((c) => c.q.ok && c.r.symbol && !c.r.symbol.includes("."));
  // Strongest surprises first when slots are scarce.
  candidates.sort((a, b) => (b.q.surprise ?? 0) - (a.q.surprise ?? 0));

  const existing = await prisma.stockPaperPosition.findMany({
    select: { symbol: true, reportDate: true },
  });
  const played = new Set(existing.map((p) => `${p.symbol}|${p.reportDate}`));

  let opened = 0;
  for (const { r, q } of candidates) {
    if (slots <= 0 || cashAvail < cfg.perPositionUsd) break;
    if (played.has(`${r.symbol}|${r.date}`)) continue;
    try {
      const asset = await getAsset(r.symbol);
      if (!asset?.tradable) continue;
      const price = await latestTradePrice(r.symbol);
      if (price == null || price < cfg.minPrice) continue;
      const dv = await avgDollarVolume(r.symbol);
      if (dv == null || dv < cfg.minAvgDollarVolume) continue;

      const order = asset.fractionable
        ? await placeMarketOrder({ symbol: r.symbol, side: "buy", notional: cfg.perPositionUsd })
        : await placeMarketOrder({
            symbol: r.symbol,
            side: "buy",
            qty: Math.floor(cfg.perPositionUsd / price),
          });
      const fill = await waitForFill(order.id);
      if (!fill) continue;
      const entrySpy = await latestTradePrice(cfg.benchmarkSymbol);
      const openedAt = isoNow();
      await prisma.stockPaperPosition.create({
        data: {
          symbol: r.symbol,
          reportDate: r.date,
          epsEstimate: r.epsEstimate ?? 0,
          epsActual: r.epsActual ?? 0,
          surprisePct: q.surprise ?? 0,
          side: "long",
          qty: fill.qty,
          entryPrice: fill.price,
          costUsd: +(fill.qty * fill.price).toFixed(2),
          entrySpy,
          status: "open",
          openedAt,
          exitDue: exitDueISO(openedAt),
          entryOrderId: order.id,
          revEstimate: r.revenueEstimate,
          revActual: r.revenueActual,
        },
      });
      played.add(`${r.symbol}|${r.date}`);
      cashAvail -= fill.qty * fill.price;
      slots--;
      opened++;
    } catch (err) {
      if (/P2002|Unique constraint/i.test(String(err))) continue; // cross-run race
      console.warn(`[pead] entry failed for ${r.symbol}: ${(err as Error).message}`);
    }
  }
  return { opened, scanned: reports.length, qualified: candidates.length };
}

export async function writeStockSnapshot(): Promise<StockPaperStats> {
  const s = await computeStockStats();
  await prisma.stockPaperSnapshot.create({
    data: {
      ts: isoNow(),
      equityUsd: s.equityUsd,
      cashUsd: s.cashUsd,
      exposureUsd: s.exposureUsd,
      realizedPnlUsd: s.realizedPnlUsd,
      openCount: s.openCount,
      closedCount: s.closedCount,
      avgExcessRetPct: s.avgExcessRetPct,
    },
  });
  return s;
}

export type PeadCycleResult =
  | { skipped: "not-configured" | "market-closed" }
  | {
      skipped: null;
      settled: number;
      opened: number;
      scanned: number;
      qualified: number;
      stats: StockPaperStats;
    };

/** One full cycle: settle due exits → enter new surprises → snapshot. */
export async function runPeadCycle(now = new Date()): Promise<PeadCycleResult> {
  if (!alpacaConfigured() || !finnhubConfigured()) return { skipped: "not-configured" };
  if (!(await marketIsOpen())) return { skipped: "market-closed" };
  const settled = await settleDuePositions(now);
  const { opened, scanned, qualified } = await openNewPositions(now);
  const stats = await writeStockSnapshot();
  return { skipped: null, settled, opened, scanned, qualified, stats };
}

export interface StockLedgerView {
  stats: StockPaperStats;
  config: {
    minSurprisePct: number;
    perPositionUsd: number;
    maxConcurrent: number;
    holdCalendarDays: number;
    killMinSettles: number;
  };
  open: Array<{
    symbol: string;
    reportDate: string;
    surprisePct: number;
    entryPrice: number;
    costUsd: number;
    openedAt: string;
    exitDue: string;
  }>;
  closed: Array<{
    symbol: string;
    reportDate: string;
    surprisePct: number;
    entryPrice: number;
    exitPrice: number | null;
    pnlUsd: number | null;
    excessRetPct: number | null;
    closedAt: string | null;
  }>;
  equityCurve: Array<{ ts: string; equityUsd: number; realizedPnlUsd: number }>;
  generatedAt: string;
}

/** Read-only view for the dashboard (DB only — no Alpaca/Finnhub calls). */
export async function getStockLedgerView(): Promise<StockLedgerView> {
  const stats = await computeStockStats();
  const [open, closed, snaps] = await Promise.all([
    prisma.stockPaperPosition.findMany({ where: { status: "open" }, orderBy: { exitDue: "asc" } }),
    prisma.stockPaperPosition.findMany({
      where: { status: "closed" },
      orderBy: { closedAt: "desc" },
      take: 50,
    }),
    prisma.stockPaperSnapshot.findMany({ orderBy: { id: "desc" }, take: 200 }),
  ]);
  return {
    stats,
    config: {
      minSurprisePct: PEAD_CONFIG.minSurprisePct,
      perPositionUsd: PEAD_CONFIG.perPositionUsd,
      maxConcurrent: PEAD_CONFIG.maxConcurrent,
      holdCalendarDays: PEAD_CONFIG.holdCalendarDays,
      killMinSettles: PEAD_CONFIG.killMinSettles,
    },
    open: open.map((p) => ({
      symbol: p.symbol,
      reportDate: p.reportDate,
      surprisePct: p.surprisePct,
      entryPrice: p.entryPrice,
      costUsd: p.costUsd,
      openedAt: p.openedAt,
      exitDue: p.exitDue,
    })),
    closed: closed.map((p) => ({
      symbol: p.symbol,
      reportDate: p.reportDate,
      surprisePct: p.surprisePct,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      pnlUsd: p.pnlUsd,
      excessRetPct: p.excessRetPct,
      closedAt: p.closedAt,
    })),
    equityCurve: snaps
      .reverse()
      .map((s) => ({ ts: s.ts, equityUsd: s.equityUsd, realizedPnlUsd: s.realizedPnlUsd })),
    generatedAt: isoNow(),
  };
}
