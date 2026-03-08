import { NormalizedSnapshot, EdgeResult } from "./types";
import { combinedFriction } from "./friction";
import { fairValue, liquidityWeight, determineLeaderLagger, LeaderLaggerResult } from "./fairValue";
import { liquidityConfidence } from "./liquidity";

/**
 * Edge Engine — REWRITTEN
 *
 * OLD: Directionless gap detection.
 *   raw_diff = |P_k - P_p|  (absolute value = no direction)
 *   final_edge = adj_edge x liqConfidence x convergenceRate
 *   -> Resulted in buying the CHEAP side regardless of who was right
 *
 * NEW: Directional edge that follows the leader.
 *   1. Detect WHO is leading (Poly or Kalshi) via lead-lag correlation
 *   2. Compute SIGNED gap (direction matters)
 *   3. Only generate edge when leader is confirmed with momentum
 *   4. Edge direction = leader's direction (we FOLLOW, not fade)
 *
 * Critical insight from backtest:
 *   POLY-leads trades: 368W-33L (91.8%), +$205K
 *   KALSHI-leads trades: 57W-397L (12.6%), -$133K
 *   -> ONLY trade when POLY leads
 */

export interface EdgeOptions {
  convergenceRate?: number;
  orderSize?: number;
}

export interface DirectionalEdgeResult extends EdgeResult {
  /** Which market is leading price discovery */
  leader: "POLY" | "KALSHI" | "UNKNOWN";
  /** Confidence in leader detection 0-1 */
  leaderConfidence: number;
  /** Direction of the leader's move */
  direction: "UP" | "DOWN" | "FLAT";
  /** Signed edge: positive = Poly > Kalshi (buy YES on Kalshi) */
  signedGap: number;
  /** Whether momentum is confirmed on the leader */
  momentumConfirmed: boolean;
  /** Momentum strength 0-1 */
  momentumStrength: number;
}

/**
 * Compute directional edge using leader detection.
 *
 * @param poly           Current Poly snapshot
 * @param kalshi         Current Kalshi snapshot
 * @param polyHistory    Array of recent Poly midpoints for leader detection
 * @param kalshiHistory  Array of recent Kalshi midpoints for leader detection
 * @param options        EdgeOptions (convergenceRate, orderSize)
 */
export function computeDirectionalEdge(
  poly: NormalizedSnapshot,
  kalshi: NormalizedSnapshot,
  polyHistory: number[],
  kalshiHistory: number[],
  options: EdgeOptions = {}
): DirectionalEdgeResult {
  const { convergenceRate = 1.0, orderSize = 100 } = options;

  // Step 1: Detect leader using price history
  const leaderResult = determineLeaderLagger(polyHistory, kalshiHistory, 8);

  // Step 2: Signed gap (Poly - Kalshi, preserving direction)
  const signedGap = poly.midpoint - kalshi.midpoint;
  const rawDiff = Math.abs(signedGap);

  // Step 3: Friction
  const fric = combinedFriction(poly, kalshi, orderSize);
  const adjEdge = Math.max(0, rawDiff - fric.max);

  // Step 4: Liquidity confidence
  const maxDepth = Math.max(poly.depthAtBest, kalshi.depthAtBest);
  const maxVolume = Math.max(poly.volume24h, kalshi.volume24h);
  const polyConf = liquidityConfidence(poly, maxDepth, maxVolume);
  const kalConf = liquidityConfidence(kalshi, maxDepth, maxVolume);
  const liqConfidence = Math.min(polyConf, kalConf);

  // Step 5: Momentum confirmation on leader's market
  const leaderHistory = leaderResult.leader === "POLY" ? polyHistory : kalshiHistory;
  const { confirmed: momentumConfirmed, strength: momentumStrength } =
    confirmMomentum(leaderHistory, leaderResult.direction);

  // Step 6: Reliability — now includes leader confidence and momentum
  const reliability =
    liqConfidence *
    convergenceRate *
    leaderResult.confidence *
    (momentumConfirmed ? 1.0 : 0.3); // heavy penalty for unconfirmed momentum

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
    leader: leaderResult.leader,
    leaderConfidence: leaderResult.confidence,
    direction: leaderResult.direction,
    signedGap,
    momentumConfirmed,
    momentumStrength,
  };
}

/**
 * Momentum confirmation — checks that a detected move is real signal, not noise.
 */
function confirmMomentum(
  priceHistory: number[],
  direction: "UP" | "DOWN" | "FLAT",
  minMove = 0.012,
  minSustained = 2
): { confirmed: boolean; strength: number } {
  if (direction === "FLAT" || priceHistory.length < minSustained + 2) {
    return { confirmed: false, strength: 0 };
  }

  const recent = priceHistory.slice(-(minSustained + 2));
  const totalMove = recent[recent.length - 1] - recent[0];

  if (Math.abs(totalMove) < minMove) return { confirmed: false, strength: 0 };
  if (direction === "UP" && totalMove <= 0) return { confirmed: false, strength: 0 };
  if (direction === "DOWN" && totalMove >= 0) return { confirmed: false, strength: 0 };

  let consistentTicks = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (direction === "UP" && diff > 0) consistentTicks++;
    if (direction === "DOWN" && diff < 0) consistentTicks++;
  }
  if (consistentTicks < minSustained) return { confirmed: false, strength: 0 };

  const lastMove = recent[recent.length - 1] - recent[recent.length - 2];
  if (direction === "UP" && lastMove < -0.005) return { confirmed: false, strength: 0 };
  if (direction === "DOWN" && lastMove > 0.005) return { confirmed: false, strength: 0 };

  const strength = Math.min(1.0, Math.abs(totalMove) / 0.05) *
    (consistentTicks / recent.length);

  return { confirmed: true, strength: Math.round(strength * 1000) / 1000 };
}

// ─── Legacy adapter (for code that still calls the old signature) ────────────

/**
 * @deprecated Use computeDirectionalEdge() instead.
 * This preserves the old interface for non-autopilot callers.
 */
export function computeEdge(
  poly: NormalizedSnapshot,
  kalshi: NormalizedSnapshot,
  options: EdgeOptions = {}
): EdgeResult {
  const { convergenceRate = 1.0, orderSize = 100 } = options;
  const rawDiff = Math.abs(kalshi.midpoint - poly.midpoint);
  const fric = combinedFriction(poly, kalshi, orderSize);
  const adjEdge = Math.max(0, rawDiff - fric.max);
  const maxDepth = Math.max(poly.depthAtBest, kalshi.depthAtBest);
  const maxVolume = Math.max(poly.volume24h, kalshi.volume24h);
  const polyConf = liquidityConfidence(poly, maxDepth, maxVolume);
  const kalConf = liquidityConfidence(kalshi, maxDepth, maxVolume);
  const liqConfidence = Math.min(polyConf, kalConf);
  const reliability = liqConfidence * convergenceRate;
  const finalEdge = adjEdge * reliability;
  const wPoly = liquidityWeight(poly, maxDepth, maxVolume);
  const wKal = liquidityWeight(kalshi, maxDepth, maxVolume);
  const pFair = fairValue(poly.midpoint, kalshi.midpoint, wPoly, wKal);

  return { rawDiff, friction: fric.max, adjEdge, reliability, finalEdge, pFair };
}

/**
 * Directional convergence tracking — replaces the old estimateConvergenceRate.
 *
 * OLD: Simple "proportion of diffs that narrowed" — useless because it doesn't
 *      track WHICH direction convergence happens in.
 *
 * NEW: Tracks whether the lagger is catching up to the leader specifically.
 */
export function estimateDirectionalConvergenceRate(
  signedGaps: number[], // poly.mid - kalshi.mid over time
  window = 20
): number {
  if (signedGaps.length < 3) return 0.5;

  const recent = signedGaps.slice(-window);
  let converging = 0;
  let total = 0;

  for (let i = 1; i < recent.length; i++) {
    if (Math.abs(recent[i]) < Math.abs(recent[i - 1])) {
      converging++;
    }
    total++;
  }

  return total > 0 ? converging / total : 0.5;
}

// Keep old function name as alias
export { estimateDirectionalConvergenceRate as estimateConvergenceRate };
