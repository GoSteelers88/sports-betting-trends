import { Venue } from "./core.js";

export interface PolymarketConfig {
  endpoint: string;
  apiKey?: string;
}

export interface KalshiConfig {
  endpoint: string;
  apiKey?: string;
}

export interface VenueCredentials {
  polymarket?: PolymarketConfig;
  kalshi?: KalshiConfig;
}

export interface VenueAdapter<TRawMarket> {
  venue: Venue;
  fetchMarkets(): Promise<TRawMarket[]>;
  normalize(raw: TRawMarket): import("./markets.js").NormalizedMarket;
}
