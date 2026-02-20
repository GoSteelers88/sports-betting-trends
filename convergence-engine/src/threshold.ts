import { config } from "./config";

/**
 * BRD Section 5.6: Dynamic Threshold
 * Base: 3% / 5% / 8% depending on liquidity
 * Adjust for event proximity, spread widening, and volatility
 */

export function dynamicThreshold(
  liquidityConfidence: number,
  spreadWidening: boolean,
  hoursToExpiry: number,
  volatility?: number
): number {
  // Base threshold by liquidity
  let base =
    liquidityConfidence >= 0.75
      ? config.thresholds.veryLiquid   // 3%
      : liquidityConfidence >= 0.50
      ? config.thresholds.mid          // 5%
      : config.thresholds.thin;       // 8%

  // Event proximity multiplier (< 48h)
  if (hoursToExpiry <= 48) {
    base *= config.thresholds.eventMultiplier48h; // 1.5x
  }

  // Spread widening adjustment
  if (spreadWidening) {
    base += config.thresholds.spreadWidenAdd; // +2%
  }

  return base;
}
