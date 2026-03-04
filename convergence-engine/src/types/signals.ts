import { Venue } from "./core.js";
import { NormalizedMarket } from "./markets.js";

export type SignalDirection = "LONG_KALSHI" | "NO_EDGE" | "REJECTED";

export interface PairSignal {
  kalshiMarket: NormalizedMarket;
  grossEdge: number; // |poly_prob - kalshi_prob|
  fees: number; // estimated combined fees
  friction: number; // spread + slippage
  netEdge: number; // grossEdge - fees - friction
  direction: SignalDirection;
  reason: string; // human-readable why/why not
  timestamp: string;
}

export interface ConvergenceSignal extends PairSignal {
  confidence: number; // 0..1 based on liquidity weighting
  catalystWindow: {
    hoursToResolution: number;
    historicalVolatility: number;
  };
}
