import { NormalizedSnapshot } from "./types";
import { config } from "./config";

/**
 * BRD Section 5.4: Friction Model
 * friction = effective_spread + slippage + fees
 * No signal if raw_diff ≤ friction
 */

export function frictionModel(
  s: NormalizedSnapshot,
  orderSize: number
): number {
  const slippage = orderSize / Math.max(s.depthAtBest, 1) * 0.1;
  const effectiveSpread = s.spread + slippage;
  const fee = s.venue === "KALSHI"
    ? config.fees.kalshiTaker
    : config.fees.polyTaker;
  return effectiveSpread + fee;
}

export function combinedFriction(
  poly: NormalizedSnapshot,
  kalshi: NormalizedSnapshot,
  orderSize = 100
): { poly: number; kalshi: number; max: number } {
  const fPoly = frictionModel(poly, orderSize);
  const fKal = frictionModel(kalshi, orderSize);
  return {
    poly: fPoly,
    kalshi: fKal,
    max: Math.max(fPoly, fKal),
  };
}

export function isFrictionBlocking(
  rawDiff: number,
  frictionMax: number
): boolean {
  return rawDiff <= frictionMax;
}
