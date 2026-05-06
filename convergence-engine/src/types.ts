export type Venue = "KALSHI";

// BRD Section 7: Data requirements
export interface BookTop {
  bid: number;  // [0..1]
  ask: number;  // [0..1]
}

export interface MarketSnapshot {
  venue: Venue;
  marketId: string;
  // BRD requires: timestamp, marketId, venue
  ts: number;  // UnixMs
  top: BookTop;
  // BRD requires: bid, ask, spread, depth, volume, midpoint
  depthAtBest: number;
  volume24h: number;
}

export interface NormalizedSnapshot extends MarketSnapshot {
  midpoint: number;
  spread: number;
}

// BRD Section 5.2: Contract mapping validation
export interface MarketMapping {
  mappingId: string;
  kalshiMarketId: string;
  kalshiResolutionText: string;
  kalshiExpiryTs: number;
  equivalenceScore: number;  // semantic match 0..1
  validated: boolean;
}

// BRD Section 5.5: Edge computation
export interface EdgeResult {
  rawDiff: number;
  friction: number;
  adjEdge: number;
  reliability: number;       // liquidity_confidence × convergenceRate
  finalEdge: number;
  pFair: number;             // fair value price
}

// BRD Section 6: Signal
export type SignalAction = "PASS" | "FLAG" | "BLOCKED";

export interface Signal {
  mappingId: string;
  action: SignalAction;
  finalEdge: number;
  threshold: number;
  reasons: string[];
  // BRD Section 7 full data
  timestamp: number;
  marketId: string;
  venue: Venue;
  bid: number;
  ask: number;
  spread: number;
  depth: number;
  volume: number;
  midpoint: number;
  fairValue: number;
  edge: number;
}

// BRD Section 5.7: Risk Governor state
export interface RiskState {
  perMarketPct: Map<string, number>;      // marketId -> exposure
  perClusterPct: Map<string, number>;     // clusterId -> exposure
  perEventPct: Map<string, number>;       // eventId -> exposure
  totalExposurePct: number;
}

// BRD Section 9: Position sizing
export interface PositionSize {
  recommended: number;
  capped: number;      // after 30% depth cap
  kellyApplied: number;
  limitReasons: string[];
}

// BRD Section 10: Backtest
export interface BacktestTrade {
  entrySignal: Signal;
  entryPrice: number;
  exitPrice?: number;
  exitTs?: number;
  pnl: number;
  status: "OPEN" | "CLOSED" | "EXPIRED";
}

export interface BacktestResult {
  totalTrades: number;
  winRate: number;
  avgNetEdge: number;
  sharpeRatio: number;
  maxDrawdown: number;
  falsePositiveRate: number;
  trades: BacktestTrade[];
}

// BRD Section 5.9: Failure modes
export interface SystemHealth {
  venueHalt: Map<Venue, boolean>;
  apiLatencyMs: Map<Venue, number>;
  spreadWideningSince?: number;  // timestamp when widening began
  oracleDivergent: boolean;
  liquidityCollapsed: boolean;
  killSwitch: boolean;
}

// Phase 1: Net executable edge components
// net_edge = raw_edge − fee_drag − slippage_est − latency_risk − cancel_risk
export interface NetEdgeComponents {
  /** |gap| in decimal (e.g. 0.08 = 8%) */
  rawEdge: number;
  /** KALSHI_FEE_RATE × (1 − kalshiPrice): fee cost as edge fraction */
  feeDrag: number;
  /** spread/2 + market-impact: estimated fill slippage */
  slippageEst: number;
  /** latency_ms × LATENCY_RISK_PER_MS: detection-to-execution latency penalty */
  latencyRisk: number;
  /** cancel_rate × CANCEL_RISK_BASE: adverse-selection cost on resting orders */
  cancelRisk: number;
  /** rawEdge − feeDrag − slippageEst − latencyRisk − cancelRisk */
  netEdge: number;
}

/** Structured trade-rejection codes (Phase 1). */
export type RejectionReason =
  | "fee_fail"           // fee_drag alone wipes out raw_edge
  | "depth_fail"         // insufficient open interest / book depth
  | "net_edge_fail"      // net_edge < configured threshold
  | "actionability_fail" // market actionability below minimum (e.g. Low)
  | "stale_data_fail"    // model summary data is stale
  | "kill_switch_fail";  // kill switch engaged
