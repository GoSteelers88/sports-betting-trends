export type UnixMs = number;

export type Venue = "KALSHI";

export interface MoneyLike {
  // For binary markets, we model prices as probability-like [0..1]
  p: number;
}

export interface BookTop {
  bid: number; // [0..1]
  ask: number; // [0..1]
  bidSize?: number; // shares/contracts
  askSize?: number; // shares/contracts
}

export interface MarketSnapshot {
  venue: Venue;
  marketId: string;
  ts: UnixMs;
  top: BookTop;
  // Liquidity proxies
  depthAtBest: number; // shares/contracts available at best price
  volume24h: number; // contracts/shares
}

export interface NormalizedMarketSnapshot extends MarketSnapshot {
  midpoint: number; // microstructure midpoint [0..1]
  spread: number; // ask - bid
}

export interface EngineContext {
  now: UnixMs;
}
