import { Venue, UnixMs } from "./core.js";

export type ResolutionSource = "SUBJECTIVE" | "OBJECTIVE" | "TIME_SENSITIVE";

export interface NormalizedMarket {
  id: string;
  venue: Venue;
  question: string;
  endDate: string; // ISO-8601
  startDate: string; // ISO-8601
  category: string;
  // Price data
  yesPrice: number; // midpoint or last
  yesBid: number;
  yesAsk: number;
  // Liquidity
  liquidity: number;
  volume: number;
  // Spread/depth
  spread: number;
  topBidDepth: number;
  impliedProb: number; // market-implied probability [0..1]
  // Resolution
  resolutionRisk: ResolutionSource;
}

export interface KalshiRawMarket {
  // Kalshi API structure - to be defined when API access available
  ticker: string;
  title: string;
  close_time: string;
  yes_bid: number;
  yes_ask: number;
  last_price: number;
  volume: number;
}

export interface MarketDefinition {
  venue: Venue;
  marketId: string;
  // Contract metadata
  title: string;
  resolutionText: string; // canonical / normalized text
  expiryTs: UnixMs; // For mapping
  tags?: string[];
}

export interface MarketPair {
  kalshi: MarketDefinition;
  // Mapping metadata
  mappingId: string;
  equivalenceScore: number; // 0..1
}
