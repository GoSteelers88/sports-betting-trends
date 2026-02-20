import { NormalizedSnapshot } from "./types";
import { clamp01, midpoint as utilMidpoint } from "./utils";
import { config } from "./config";

/**
 * BRD Section 5.3: Fair Value Computation
 * P_fair = w_k * P_k + w_p * P_p
 *
 * Optional structural bias adjustment:
 * P_fair_adj = P_fair + β(P_leader − P_lagger)
 */

export function liquidityWeight(
  s: NormalizedSnapshot,
  maxDepth: number,
  maxVolume: number
): number {
  const spreadComponent = 1 - Math.min(1, s.spread / 0.10);
  const depthComponent = s.depthAtBest / maxDepth;
  const volComponent = s.volume24h / maxVolume;
  return clamp01(
    0.5 * spreadComponent + 0.3 * depthComponent + 0.2 * volComponent
  );
}

export function fairValue(
  pPoly: number,
  pKalshi: number,
  wPoly: number,
  wKalshi: number,
  options?: {
    enableBeta?: boolean;
    beta?: number;
    leaderPrice?: number;
    laggerPrice?: number;
  }
): number {
  const sum = wPoly + wKalshi;
  const wp = wPoly / sum;
  const wk = wKalshi / sum;
  let pFair = clamp01(wp * pPoly + wk * pKalshi);

  // BRD: Structural bias adjustment (Phase 2)
  if (config.fairValue.enableBetaAdjustment && options?.enableBeta) {
    const beta = options.beta ?? config.fairValue.betaDefault;
    const leader = options.leaderPrice ?? pPoly;
    const lagger = options.laggerPrice ?? pKalshi;
    pFair = clamp01(pFair + beta * (leader - lagger));
  }

  return pFair;
}

export function determineLeaderLagger(
  poly: NormalizedSnapshot,
  kalshi: NormalizedSnapshot,
  lookback?: number[]
): { leader: "POLYMARKET" | "KALSHI"; leaderPrice: number; laggerPrice: number } {
  // BRD Phase 2: Use cross-correlation or recency
  // Default: higher volume venue leads
  const liquidPoly = poly.volume24h > kalshi.volume24h;
  return {
    leader: liquidPoly ? "POLYMARKET" : "KALSHI",
    leaderPrice: liquidPoly ? poly.midpoint : kalshi.midpoint,
    laggerPrice: liquidPoly ? kalshi.midpoint : poly.midpoint,
  };
}
