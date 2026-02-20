// Phase 1: Net edge threshold for valid convergence trades
export const MIN_NET_EDGE = 0.04; // 4% minimum net edge

// Resolution equivalence gates
export const MAX_EXPIRY_DRIFT_MS = 24 * 60 * 60 * 1000; // 24 hours

// Liquidity thresholds
export const MIN_LIQUIDITY_USD = 10000;
export const MIN_DEPTH_AT_BEST = 500; // shares/contracts

// Catalyst adjuster (Phase 2)
export const CATALYST_VOLATILITY_MULTIPLIER = 1.0;
export const CATALYST_TIME_DECAY_HOURS = 48; // increase threshold after this window
export const CATALYST_EDGE_MULTIPLIER = 1.5; // 6% edge threshold instead of 4%

// Execution friction
export const ESTIMATED_SLIPPAGE_PCT = 0.002; // 0.2%
export const POLYMARKET_WITHDRAWAL_FEE_PCT = 0.003; // ~0.3% gas estimate
export const KALSHI_PROFIT_FEE_PCT = 0.10; // 10% of profit

// Kalshi fees only apply to winnings — net effect depends on trade outcome
export function estimateKalshiEffectiveFee(edge: number): number {
  // Rough approximation: if we win, pay 10% on net profit
  // If we lose, no fee
  // Expected fee: ~10% * P(win) * edge
  return edge * 0.10 * 0.5; // midpoint assumption
}
