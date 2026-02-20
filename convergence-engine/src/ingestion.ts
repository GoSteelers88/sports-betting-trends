import { NormalizedSnapshot, Venue } from "./types.js";
import { midpoint, spread, clamp01 } from "./utils.js";
import {
  fetchPolymarketSnapshot,
  fetchPolymarketBatched,
  findMarketByQuestion,
  fetchGammaMarkets,
} from "./adapters/polymarketAdapter.js";
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
// LIVE POLYMARKET (via adapter)
// ============================================================

/**
 * Fetch live Polymarket snapshot by conditionId
 * BRD 11: Replace mock with real adapter
 */
export async function fetchPolymarket(
  conditionId: string
): Promise<NormalizedSnapshot | null> {
  const snapshot = await fetchPolymarketSnapshot(conditionId);
  if (!snapshot) {
    console.log(`[Polymarket] Failed to fetch ${conditionId}`);
    return null;
  }
  return snapshot;
}

/**
 * Search Polymarket by question fragment
 */
export async function searchPolymarket(
  questionFragment: string
): Promise<NormalizedSnapshot | null> {
  const data = await findMarketByQuestion(questionFragment);
  if (!data) return null;

  return normalizeSnapshot("POLYMARKET", {
    marketId: data.conditionId,
    bid: data.bid,
    ask: data.ask,
    depthAtBest: data.depthAtBest,
    volume24h: data.volume24h,
    ts: data.ts,
  });
}

/**
 * Batch fetch Polymarket markets
 * BRD: Support 50+ concurrent markets with rate limiting
 */
export async function fetchPolymarketBatch(
  conditionIds: string[]
): Promise<Map<string, NormalizedSnapshot>> {
  return fetchPolymarketBatched(conditionIds);
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
  // Try live first
  if (!kalshiInitialized) {
    const ok = await initKalshi();
    if (!ok) {
      // Fall back to mock
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
  // Try live first
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
      // Return mock data for all
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
// PAIR DISCOVERY FROM AGENTS.MD QUESTIONS
// ============================================================

export interface MarketPair {
  polyConditionId?: string;
  kalshiTicker?: string;
  question: string;
  poly?: NormalizedSnapshot;
  kalshi?: NormalizedSnapshot;
  status: "found_both" | "found_poly" | "found_kalshi" | "not_found";
}

/**
 * Discover pair by searching both venues
 * Uses question fragments from AGENTS.md to find matches
 */
export async function discoverPair(
  question: string,
  kalshiTicker?: string
): Promise<MarketPair> {
  console.log(`\n[Discovery] Searching: "${question.slice(0, 60)}..."`);

  const [poly, kalshi] = await Promise.all([
    searchPolymarket(question).catch(() => null),
    kalshiTicker
      ? fetchKalshi(kalshiTicker).catch(() => null)
      : searchKalshi(question).catch(() => null),
  ]);

  const status = poly && kalshi
    ? "found_both"
    : poly
    ? "found_poly"
    : kalshi
    ? "found_kalshi"
    : "not_found";

  return {
    question,
    polyConditionId: poly?.marketId,
    kalshiTicker: kalshi?.marketId,
    poly: poly || undefined,
    kalshi: kalshi || undefined,
    status,
  };
}

// ============================================================
// TOP MARKETS FROM AGENTS.MD
// ============================================================

/**
 * Markets currently tracked in AGENTS.md (approximate)
 * These will be searched on both venues
 */
export const TRACKED_MARKETS = [
  { question: "Jesus Christ return before 2027", category: "religious" },
  { question: "Trump nominate Jerome Powell", category: "politics" },
  { question: "Trump nominate Barron Trump", category: "politics" },
  { question: "Trump nominate Larry Kudlow", category: "politics" },
  { question: "Trump nominate Janet Yellen", category: "politics" },
];

/**
 * Fetch all tracked pairs
 * BRD: Discovery phase for real markets
 */
export async function fetchTrackedPairs(): Promise<MarketPair[]> {
  console.log("Fetching live data for tracked markets...\n");

  const pairs: MarketPair[] = [];

  for (const { question } of TRACKED_MARKETS) {
    const pair = await discoverPair(question);
    pairs.push(pair);

    // Log result
    const icon = pair.status === "found_both" ? "✅"
      : pair.status === "found_poly" ? "🟡 Poly"
      : pair.status === "found_kalshi" ? "🟡 Kalshi"
      : "❌";

    console.log(`${icon} "${question.slice(0, 50)}..."`);

    if (pair.poly) {
      console.log(`   Poly: ${(pair.poly.midpoint * 100).toFixed(1)}¢ | Depth: $${pair.poly.depthAtBest.toFixed(0)} | Vol: $${(pair.poly.volume24h / 1e6).toFixed(2)}M`);
    }
    if (pair.kalshi) {
      console.log(`   Kalshi: ${(pair.kalshi.midpoint * 100).toFixed(1)}¢ | Depth: $${pair.kalshi.depthAtBest.toFixed(0)} | Vol: $${(pair.kalshi.volume24h / 1e6).toFixed(2)}M`);
    }
  }

  return pairs;
}