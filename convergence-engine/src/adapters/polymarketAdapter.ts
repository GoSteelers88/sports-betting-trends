/**
 * Polymarket Adapter
 * Hits Gamma API (market discovery) + CLOB API (order books)
 */

import { NormalizedSnapshot, Venue } from "../types.js";
import { clamp01, midpoint, spread } from "../utils.js";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  category: string;
  outcomes: Array<{
    name: string;
    price: number;
    token_id: string;
  }>;
  liquidity: number;
  volume: number;
  endDate: string;
  startDate: string;
}

interface ClobBook {
  bids: Array<{
    price: string;
    size: string;
  }>;
  asks: Array<{
    price: string;
    size: string;
  }>;
}

interface PolymarketMarketData {
  id: string;
  conditionId: string;
  question: string;
  tokenId: string;
  bid: number;
  ask: number;
  depthAtBest: number;
  volume24h: number;
  ts: number;
}

/**
 * Fetch market list from Gamma API
 * BRD: Market discovery, top 50 by liquidity per spec
 */
export async function fetchGammaMarkets(
  limit: number = 50
): Promise<GammaMarket[]> {
  const url = `${GAMMA_API}/markets?active=true&closed=false&order=liquidityNum&ascending=false&limit=${limit}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Gamma API error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  return data.markets || data;
}

/**
 * Get YES token ID from market outcomes
 * Assumes binary markets (YES/NO)
 */
export function getYesTokenId(market: GammaMarket): string | null {
  const yesOutcome = market.outcomes.find(
    (o) => o.name.toUpperCase() === "YES" || o.name.toLowerCase() === "yes"
  );
  return yesOutcome?.token_id || market.outcomes[0]?.token_id || null;
}

/**
 * Fetch order book from CLOB API for token_id
 * BRD: Pull bid, ask, depth
 */
export async function fetchClobBook(tokenId: string): Promise<ClobBook> {
  const url = `${CLOB_API}/book?token_id=${tokenId}&side=bid,ask`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    // Handle 429 rate limits with exponential backoff
    if (response.status === 429) {
      throw new Error("Rate limited by CLOB - implement backoff");
    }
    throw new Error(`CLOB error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Normalize CLOB response
  return {
    bids: Array.isArray(data.bids) ? data.bids : [],
    asks: Array.isArray(data.asks) ? data.asks : [],
  };
}

/**
 * Calculate top-of-book metrics from order book
 * BRD: bid, ask, spread, depth at best
 */
export function calculateBookMetrics(book: ClobBook): {
  bid: number;
  ask: number;
  spread: number;
  depthAtBest: number;
} {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];

  const bid = bestBid ? parseFloat(bestBid.price) / 100 : 0; // CLOB prices in cents
  const ask = bestAsk ? parseFloat(bestAsk.price) / 100 : 1;
  const depthBid = bestBid ? parseFloat(bestBid.size) : 0;
  const depthAsk = bestAsk ? parseFloat(bestAsk.size) : 0;

  return {
    bid: clamp01(bid),
    ask: clamp01(ask),
    spread: clamp01(ask - bid),
    depthAtBest: Math.min(depthBid, depthAsk), // Conservative: min of bid/ask depth
  };
}

/**
 * Fetch complete market snapshot for a conditionId
 * BRD 5.1: timestamp, bid, ask, spread, depth, volume, midpoint
 */
export async function fetchPolymarketSnapshot(
  conditionId: string
): Promise<NormalizedSnapshot | null> {
  const start = Date.now();

  try {
    // 1. Get market from Gamma (for volume and token mapping)
    const markets = await fetchGammaMarkets();
    const market = markets.find((m) => m.conditionId === conditionId);

    if (!market) {
      console.log(`[Polymarket] Market ${conditionId} not found`);
      return null;
    }

    const tokenId = getYesTokenId(market);
    if (!tokenId) {
      console.log(`[Polymarket] No token found for ${conditionId}`);
      return null;
    }

    // 2. Get order book from CLOB
    const book = await fetchClobBook(tokenId);
    const metrics = calculateBookMetrics(book);

    // 3. Build normalized snapshot
    const ts = Date.now();
    const latency = ts - start;

    const snapshot: NormalizedSnapshot = {
      venue: "POLYMARKET" as Venue,
      marketId: conditionId,
      ts,
      top: {
        bid: metrics.bid,
        ask: metrics.ask,
      },
      depthAtBest: metrics.depthAtBest,
      volume24h: market.volume || 0,
      midpoint: midpoint(metrics.bid, metrics.ask),
      spread: metrics.spread,
    };

    // BRD 5.1: Latency check (< 3 seconds)
    if (latency > 3000) {
      console.warn(
        `[Polymarket] Latency ${latency}ms exceeds 3000ms threshold`
      );
    }

    return snapshot;
  } catch (error) {
    console.error(`[Polymarket] Error fetching ${conditionId}:`, error);
    return null;
  }
}

/**
 * Fetch by question text (fuzzy match)
 * Useful for finding markets without conditionId
 */
export async function findMarketByQuestion(
  questionFragment: string
): Promise<PolymarketMarketData | null> {
  try {
    const markets = await fetchGammaMarkets(100);

    const market = markets.find((m) =>
      m.question.toLowerCase().includes(questionFragment.toLowerCase())
    );

    if (!market) return null;

    const tokenId = getYesTokenId(market);
    if (!tokenId) return null;

    const book = await fetchClobBook(tokenId);
    const metrics = calculateBookMetrics(book);

    return {
      id: market.id,
      conditionId: market.conditionId,
      question: market.question,
      tokenId,
      bid: metrics.bid,
      ask: metrics.ask,
      depthAtBest: metrics.depthAtBest,
      volume24h: market.volume || 0,
      ts: Date.now(),
    };
  } catch (error) {
    console.error("[Polymarket] Error finding market:", error);
    return null;
  }
}

/**
 * Batch fetch multiple markets
 * BRD: Support 50+ concurrent markets
 */
export async function fetchPolymarketBatched(
  conditionIds: string[]
): Promise<Map<string, NormalizedSnapshot>> {
  const results = new Map<string, NormalizedSnapshot>();

  // Process in batches of 5 to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < conditionIds.length; i += batchSize) {
    const batch = conditionIds.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (cid) => {
        const snapshot = await fetchPolymarketSnapshot(cid);
        return { cid, snapshot };
      })
    );

    for (const { cid, snapshot } of batchResults) {
      if (snapshot) {
        results.set(cid, snapshot);
      }
    }

    // BRD: Rate limiting - delay between batches
    if (i + batchSize < conditionIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
