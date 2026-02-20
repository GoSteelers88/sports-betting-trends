// Liquidity weighting for confidence adjustment

export const LIQUIDITY_THRESHOLD = 100_000; // USD
export const VOLUME_THRESHOLD_24H = 50_000; // USD

export interface LiquidityScore {
  venue: string;
  normalizedLiquidity: number; // 0..1
  normalizedVolume: number; // 0..1
  composite: number; // weighted average
}

export function calculateLiquidityWeight(
  liquidity: number,
  volume24h: number
): number {
  const liqScore = Math.min(liquidity / LIQUIDITY_THRESHOLD, 1.0);
  const volScore = Math.min(volume24h / VOLUME_THRESHOLD_24H, 1.0);
  return (liqScore * 0.6) + (volScore * 0.4);
}

// Confidence multiplier based on book quality
export function confidenceFromSpread(
  spread: number,
  minSpread: number = 0.01,
  maxSpread: number = 0.05
): number {
  if (spread <= minSpread) return 1.0;
  if (spread >= maxSpread) return 0.0;
  return 1.0 - (spread - minSpread) / (maxSpread - minSpread);
}
