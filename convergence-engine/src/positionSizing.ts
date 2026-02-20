import { PositionSize, NormalizedSnapshot } from "./types";
import { config } from "./config";

/**
 * BRD Section 5.8: Position Sizing
 * Half-Kelly sizing capped at 30% of top-of-book depth
 */

// Kelly criterion: f = (p*b - q) / b
// Half-Kelly: f/2
export function kellyFraction(
  winProb: number,
  odds: number,        // net odds received (e.g., 1.0 for even money)
): number {
  const q = 1 - winProb;
  const k = (winProb * odds - q) / odds;
  return Math.max(0, k);
}

export function halfKelly(
  winProb: number,
  odds: number,
  bankroll: number
): number {
  const k = kellyFraction(winProb, odds);
  return bankroll * k * config.sizing.kellyFraction;
}

export function computePositionSize(
  edge: number,
  pFair: number,
  poly: NormalizedSnapshot,
  kalshi: NormalizedSnapshot,
  bankroll: number
): PositionSize {
  const reasons: string[] = [];

  // Calculate win probability from edge
  // Simplified: if taking the cheaper side, winProb = 1 - pFair + edge
  const winProb = pFair + edge;
  const odds = pFair / (1 - pFair); // approximate

  // Kelly sizing
  const kellyAmount = halfKelly(winProb, odds, bankroll);
  const kellyApplied = kellyAmount;

  // Cap at 30% of depth (conservative, using minimum of both venues)
  const minDepth = Math.min(poly.depthAtBest, kalshi.depthAtBest);
  const depthCap = minDepth * config.sizing.maxDepthParticipation;

  let capped = Math.min(kellyAmount, depthCap);

  if (capped < kellyAmount) {
    reasons.push(
      `Capped at ${(config.sizing.maxDepthParticipation * 100).toFixed(0)}% of depth (${minDepth})`
    );
  }

  // Absolute minimum
  if (capped < 1) {
    reasons.push("Position below minimum size");
    capped = 0;
  }

  return {
    recommended: kellyAmount,
    capped,
    kellyApplied,
    limitReasons: reasons,
  };
}
