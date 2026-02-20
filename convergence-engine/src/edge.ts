import { NormalizedSnapshot, EdgeResult } from "./types";
import { combinedFriction, frictionModel } from "./friction";
import { fairValue, liquidityWeight } from "./fairValue";
import { liquidityConfidence } from "./liquidity";

/**
 * BRD Section 5.5: Edge Engine
 * raw_diff = |P_k − P_p|
 * adj_edge = raw_diff − friction
 * final_edge = adj_edge × liquidity_confidence × convergenceRate
 */

export interface EdgeOptions {
  convergenceRate?: number;  // BRD: historical convergence rate 0..1
  orderSize?: number;
}

export function computeEdge(
  poly: NormalizedSnapshot,
  kalshi: NormalizedSnapshot,
  options: EdgeOptions = {}
): EdgeResult {
  const { convergenceRate = 1.0, orderSize = 100 } = options;

  // Raw difference
  const rawDiff = Math.abs(kalshi.midpoint - poly.midpoint);

  // Friction
  const fric = combinedFriction(poly, kalshi, orderSize);

  // Adjusted edge
  const adjEdge = Math.max(0, rawDiff - fric.max);

  // Liquidity confidence (min of both venues)
  const maxDepth = Math.max(poly.depthAtBest, kalshi.depthAtBest);
  const maxVolume = Math.max(poly.volume24h, kalshi.volume24h);
  const polyConf = liquidityConfidence(poly, maxDepth, maxVolume);
  const kalConf = liquidityConfidence(kalshi, maxDepth, maxVolume);
  const liqConfidence = Math.min(polyConf, kalConf);

  // Reliability
  const reliability = liqConfidence * convergenceRate;

  // Final edge
  const finalEdge = adjEdge * reliability;

  // Fair value
  const wPoly = liquidityWeight(poly, maxDepth, maxVolume);
  const wKal = liquidityWeight(kalshi, maxDepth, maxVolume);
  const pFair = fairValue(poly.midpoint, kalshi.midpoint, wPoly, wKal);

  return {
    rawDiff,
    friction: fric.max,
    adjEdge,
    reliability,
    finalEdge,
    pFair,
  };
}

// BRD Section 11: Learn β via cross-correlation (Phase 2)
export function estimateConvergenceRate(
  historicalDiffs: number[],
  window = 20
): number {
  if (historicalDiffs.length < 2) return 1.0;
  // Simple mean reversion: proportion of diffs that narrowed
  let narrowed = 0;
  for (let i = 1; i < Math.min(historicalDiffs.length, window); i++) {
    if (historicalDiffs[i] < historicalDiffs[i - 1]) {
      narrowed++;
    }
  }
  return narrowed / (Math.min(historicalDiffs.length, window) - 1);
}
