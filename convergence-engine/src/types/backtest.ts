import { ConvergenceSignal } from "./signals.js";

export interface BacktestTrade {
  entry: {
    signal: ConvergenceSignal;
    price: number;
    timestamp: string;
  };
  exit?: {
    price: number;
    timestamp: string;
    pnl: number;
  };
  status: "OPEN" | "CLOSED" | "EXPIRED";
}

export interface BacktestResult {
  totalTrades: number;
  winRate: number;
  avgEdge: number;
  avgNetEdge: number;
  sharpeRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  trades: BacktestTrade[];
}
