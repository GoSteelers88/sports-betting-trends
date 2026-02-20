export const config = {
  // BRD Section 5.6: Dynamic thresholds
  thresholds: {
    veryLiquid: 0.03,
    mid: 0.05,
    thin: 0.08,
    eventMultiplier48h: 1.5,
    spreadWidenAdd: 0.02,
  },

  // BRD Section 5.7: Portfolio Governor limits
  risk: {
    maxPerMarketPct: 0.05,         // 5%
    maxPerClusterPct: 0.15,      // 15%
    maxPerEventPct: 0.20,        // 20%
    maxTotalExposurePct: 0.40,   // 40%
  },

  // BRD Section 5.4: Friction / fees
  fees: {
    kalshiTaker: 0.01,
    polyTaker: 0.0,
  },

  // BRD Section 5.1: Latency requirements
  latency: {
    maxApiLatencyMs: 3500,
  },

  // BRD Section 5.2: Mapping validation
  mapping: {
    maxExpiryDriftHours: 24,
    semanticMatchThreshold: 0.85,
  },

  // BRD Section 5.8: Position sizing
  sizing: {
    kellyFraction: 0.5,          // Half-Kelly
    maxDepthParticipation: 0.30, // 30% of top-of-book
  },

  // BRD Section 5.9: Failure modes
  failure: {
    spreadWidenTimeoutSec: 300,  // 5 minutes
    minLiquidityUsd: 10000,
  },

  // BRD Section 5.3: Structural bias (optional Phase 2)
  fairValue: {
    enableBetaAdjustment: false,
    betaDefault: 0.1,
  },

  // BRD Section 5.5 Liquidity weighting
  liquidity: {
    spreadThreshold: 0.05,
    wSpread: 0.45,
    wDepth: 0.35,
    wVolume: 0.20,
    minConfidence: 0.4,
  },
};
