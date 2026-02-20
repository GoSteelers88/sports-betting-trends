import { BacktestResult, BacktestTrade, Signal } from "./types";

/**
 * BRD Section 10: Backtest Engine
 * - Backtested win rate ≥ 60% on flagged signals
 * - Average net edge capture ≥ 50% of theoretical edge
 * - Max drawdown < 15% simulated capital
 */

export function createBacktestResult(
  trades: BacktestTrade[] = []
): BacktestResult {
  return {
    totalTrades: 0,
    winRate: 0,
    avgNetEdge: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    falsePositiveRate: 0,
    trades,
  };
}

export function computeBacktestMetrics(
  result: BacktestResult
): BacktestResult {
  if (result.trades.length === 0) {
    return result;
  }

  const closedTrades = result.trades.filter((t) => t.status === "CLOSED");
  const winningTrades = closedTrades.filter((t) => t.pnl > 0);

  // Win rate
  const winRate =
    closedTrades.length > 0 ? winningTrades.length / closedTrades.length : 0;

  // Average net edge capture
  const avgNetEdge =
    closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + t.pnl, 0) / closedTrades.length
      : 0;

  // Returns for Sharpe / drawdown
  const returns = closedTrades.map((t) => t.pnl);

  // Sharpe ratio (simplified, assuming risk-free = 0)
  const avgReturn =
    returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev = Math.sqrt(
    returns.length > 0
      ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
          returns.length
      : 0
  );
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

  // Max drawdown
  let maxDrawdown = 0;
  let peak = 0;
  let cumulative = 0;
  for (const pnl of returns) {
    cumulative += pnl;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  // False positive rate (FLAG but no profit)
  const flagged = result.trades.filter((t) => t.entrySignal.action === "FLAG");
  const falsePositives = flagged.filter((t) => t.status === "CLOSED" && t.pnl <= 0);
  const falsePositiveRate =
    flagged.length > 0 ? falsePositives.length / flagged.length : 0;

  return {
    ...result,
    totalTrades: result.trades.length,
    winRate,
    avgNetEdge,
    sharpeRatio,
    maxDrawdown,
    falsePositiveRate,
  };
}

export function addTrade(
  result: BacktestResult,
  signal: Signal,
  entryPrice: number
): BacktestResult {
  const trade: BacktestTrade = {
    entrySignal: signal,
    entryPrice,
    status: "OPEN",
    pnl: 0,
  };
  return {
    ...result,
    trades: [...result.trades, trade],
  };
}

export function closeTrade(
  result: BacktestResult,
  tradeIndex: number,
  exitPrice: number
): BacktestResult {
  const trades = [...result.trades];
  const trade = trades[tradeIndex];
  if (!trade || trade.status !== "OPEN") {
    return result;
  }
  trades[tradeIndex] = {
    ...trade,
    exitPrice,
    exitTs: Date.now(),
    pnl: exitPrice - trade.entryPrice, // directional
    status: "CLOSED",
  };
  return { ...result, trades };
}

export function expireTrade(
  result: BacktestResult,
  tradeIndex: number,
  exitPrice: number
): BacktestResult {
  const trades = [...result.trades];
  const trade = trades[tradeIndex];
  if (!trade || trade.status !== "OPEN") {
    return result;
  }
  trades[tradeIndex] = {
    ...trade,
    exitPrice,
    exitTs: Date.now(),
    pnl: exitPrice - trade.entryPrice,
    status: "EXPIRED",
  };
  return { ...result, trades };
}
