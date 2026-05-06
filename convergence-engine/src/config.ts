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

  // Phase 1: Net executable edge scoring
  // Override minNetEdge at runtime via AUTOPILOT_NET_EDGE_THRESHOLD env var (autopilot only).
  netEdge: {
    /** Minimum net_edge required to open a trade (default 0.03 = 3%) */
    minNetEdge: 0.03,
    /** Kalshi profit fee rate applied to winning trades */
    feeDragRate: 0.07,
    /** Edge reduction per ms of execution latency (0.2 bp/ms) */
    latencyRiskPerMs: 0.000002,
    /** Base adverse-selection cost for resting orders (0.2%) */
    cancelRiskBase: 0.002,
    /** Assumed API round-trip latency in ms */
    defaultLatencyMs: 200,
    /** Historical resting-order cancel rate (0–1) */
    defaultCancelRate: 0.15,
  },
};
