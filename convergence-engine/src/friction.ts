import { NormalizedSnapshot, NetEdgeComponents } from "./types";
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

// ─── Phase 1: Net executable edge components ─────────────────────────────────
//
// net_edge = raw_edge − fee_drag − slippage_est − latency_risk − cancel_risk
//
// Components:
//   fee_drag     = KALSHI_FEE_RATE × (1 − kalshiPrice)  — 7% profit fee
//   slippage_est = spread/2 + market-impact              — fill slippage
//   latency_risk = latency_ms × 0.2bp/ms                — detection→exec lag
//   cancel_risk  = cancel_rate × 0.2%                   — resting-order ADS

const KALSHI_FEE_RATE     = 0.07;       // 7% on profits
const LATENCY_RISK_PER_MS = 0.000002;   // 0.2 bp per ms of execution latency
const CANCEL_RISK_BASE    = 0.002;      // 0.2% base adverse-selection cost

export interface NetEdgeInput {
  /** |gap| in decimal (e.g. 0.08 = 8%) */
  rawEdge: number;
  /** Kalshi price for the intended side, 0–1 */
  kalshiPrice: number;
  /** Bid-ask spread in decimal (same units as rawEdge) */
  spread: number;
  /** Depth at best in USD-equivalent units */
  depthAtBest: number;
  /** Intended order size in USD */
  orderSizeUsd: number;
  /** Assumed API round-trip latency in ms (default: config.netEdge.defaultLatencyMs) */
  latencyMs?: number;
  /** Historical resting-order cancel rate 0–1 (default: config.netEdge.defaultCancelRate) */
  historicalCancelRate?: number;
}

/**
 * Compute net executable edge components.
 * Returns each cost component plus the final net_edge scalar.
 * Callers should gate on netEdge >= config.netEdge.minNetEdge.
 */
export function computeNetEdgeComponents(input: NetEdgeInput): NetEdgeComponents {
  const {
    rawEdge,
    kalshiPrice,
    spread,
    depthAtBest,
    orderSizeUsd,
    latencyMs       = config.netEdge.defaultLatencyMs,
    historicalCancelRate = config.netEdge.defaultCancelRate,
  } = input;

  const feeDrag     = KALSHI_FEE_RATE * (1 - kalshiPrice);
  const mktImpact   = (orderSizeUsd / Math.max(depthAtBest, 1)) * 0.1;
  const slippageEst = spread / 2 + mktImpact;
  const latencyRisk = latencyMs * LATENCY_RISK_PER_MS;
  const cancelRisk  = historicalCancelRate * CANCEL_RISK_BASE;
  const netEdge     = rawEdge - feeDrag - slippageEst - latencyRisk - cancelRisk;

  return { rawEdge, feeDrag, slippageEst, latencyRisk, cancelRisk, netEdge };
}
