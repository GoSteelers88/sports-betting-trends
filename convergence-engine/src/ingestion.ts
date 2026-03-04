import { NormalizedSnapshot, Venue } from "./types.js";
import { midpoint, spread, clamp01 } from "./utils.js";
import {
  fetchKalshiSnapshot,
  findKalshiByQuestion,
  fetchKalshiBatched,
  kalshiAuth,
} from "./adapters/kalshiAdapter.js";

/**
 * BRD Section 5.1: Market Ingestion
 * - Pull bid, ask, depth, 24h volume
 * - Normalize prices to 0–1
 * - Store timestamped snapshots
 * - Evaluation latency < 3 seconds
 */

export interface RawMarketData {
  marketId: string;
  bid: number;
  ask: number;
  depthAtBest: number;
  volume24h: number;
  ts?: number;
}

export function normalizeSnapshot(
  venue: Venue,
  data: RawMarketData
): NormalizedSnapshot {
  return {
    venue,
    marketId: data.marketId,
    ts: data.ts ?? Date.now(),
    top: {
      bid: clamp01(data.bid),
      ask: clamp01(data.ask),
    },
    depthAtBest: Math.max(0, data.depthAtBest),
    volume24h: Math.max(0, data.volume24h),
    midpoint: midpoint(data.bid, data.ask),
    spread: spread(data.bid, data.ask),
  };
}

// ============================================================
// LIVE KALSHI (via adapter, requires credentials)
// ============================================================

let kalshiInitialized = false;

/**
 * Initialize Kalshi with credentials from environment
 */
export async function initKalshi(): Promise<boolean> {
  if (kalshiInitialized) return true;

  const email = process.env.KALSHI_EMAIL;
  const password = process.env.KALSHI_PASSWORD;

  if (!email || !password) {
    console.log("[Kalshi] No credentials - using mock data");
    return false;
  }

  try {
    await kalshiAuth({ email, password });
    kalshiInitialized = true;
    console.log("[Kalshi] Authenticated successfully");
    return true;
  } catch (e) {
    console.log("[Kalshi] Auth failed, using mock data:", e instanceof Error ? e.message : "");
    return false;
  }
}

/**
 * Fetch live Kalshi snapshot by ticker
 */
export async function fetchKalshi(
  ticker: string
): Promise<NormalizedSnapshot | null> {
  if (!kalshiInitialized) {
    const ok = await initKalshi();
    if (!ok) {
      return mockKalshi(ticker);
    }
  }

  const snapshot = await fetchKalshiSnapshot(ticker);
  return snapshot;
}

/**
 * Mock Kalshi data (fallback when no credentials)
 */
function mockKalshi(ticker: string): NormalizedSnapshot {
  return normalizeSnapshot("KALSHI", {
    marketId: ticker,
    bid: 0.47 + Math.random() * 0.02,
    ask: 0.50 + Math.random() * 0.02,
    depthAtBest: 300 + Math.floor(Math.random() * 100),
    volume24h: 12000 + Math.floor(Math.random() * 5000),
  });
}

/**
 * Search Kalshi by title fragment
 */
export async function searchKalshi(
  titleFragment: string
): Promise<NormalizedSnapshot | null> {
  if (!kalshiInitialized) {
    const ok = await initKalshi();
    if (!ok) return null;
  }

  return findKalshiByQuestion(titleFragment);
}

/**
 * Batch fetch Kalshi markets
 */
export async function fetchKalshiBatch(
  tickers: string[]
): Promise<Map<string, NormalizedSnapshot>> {
  if (!kalshiInitialized) {
    const ok = await initKalshi();
    if (!ok) {
      const results = new Map<string, NormalizedSnapshot>();
      for (const t of tickers) {
        results.set(t, mockKalshi(t));
      }
      return results;
    }
  }
  return fetchKalshiBatched(tickers);
}

// ============================================================
// MARKET DISCOVERY
// ============================================================

export interface MarketResult {
  kalshiTicker?: string;
  question: string;
  kalshi?: NormalizedSnapshot;
  status: "found" | "not_found";
}

/**
 * Discover a Kalshi market by ticker or question fragment
 */
export async function discoverMarket(
  question: string,
  kalshiTicker?: string
): Promise<MarketResult> {
  console.log(`\n[Discovery] Searching: "${question.slice(0, 60)}..."`);

  const kalshi = kalshiTicker
    ? await fetchKalshi(kalshiTicker).catch(() => null)
    : await searchKalshi(question).catch(() => null);

  return {
    question,
    kalshiTicker: kalshi?.marketId,
    kalshi: kalshi || undefined,
    status: kalshi ? "found" : "not_found",
  };
}

/**
 * Markets currently tracked in AGENTS.md
 */
export const TRACKED_MARKETS = [
  { question: "Jesus Christ return before 2027", category: "religious" },
  { question: "Trump nominate Jerome Powell", category: "politics" },
  { question: "Trump nominate Barron Trump", category: "politics" },
  { question: "Trump nominate Larry Kudlow", category: "politics" },
  { question: "Trump nominate Janet Yellen", category: "politics" },
];

/**
 * Fetch all tracked markets on Kalshi
 */
export async function fetchTrackedMarkets(): Promise<MarketResult[]> {
  console.log("Fetching live Kalshi data for tracked markets...\n");

  const results: MarketResult[] = [];

  for (const { question } of TRACKED_MARKETS) {
    const result = await discoverMarket(question);
    results.push(result);

    const icon = result.status === "found" ? "✅" : "❌";
    console.log(`${icon} "${question.slice(0, 50)}..."`);

    if (result.kalshi) {
      console.log(`   Kalshi: ${(result.kalshi.midpoint * 100).toFixed(1)}¢ | Depth: $${result.kalshi.depthAtBest.toFixed(0)} | Vol: $${(result.kalshi.volume24h / 1e6).toFixed(2)}M`);
    }
  }

  return results;
}
