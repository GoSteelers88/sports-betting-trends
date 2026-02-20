/**
 * Kalshi Adapter
 * Trading API client (requires credentials)
 * https://trading-api.kalshi.com/
 *
 * BRD 5.1: Market Ingestion - Kalshi
 * BRD 11: Replace mock with real adapter
 */

import { NormalizedSnapshot } from "../types.js";
import { midpoint as utilMidpoint } from "../utils.js";

const KALSHI_API = "https://trading-api.kalshi.com/trade-api/v2";

interface KalshiCredentials {
  email?: string;
  password?: string;
  apiKey?: string;  // Preferred: Bearer token from Kalshi settings
}

interface KalshiMarket {
  ticker: string;
  title: string;
  status: string;
  expiration_time: string;
  yes_bid: number;     // in cents
  yes_ask: number;     // in cents
  volume: number;
  open_interest: number;
}

interface KalshiMarketResponse {
  markets: KalshiMarket[];
  cursor?: string;
  has_more: boolean;
}

interface KalshiOrderBook {
  yes_bids: Array<{
    price: number;  // cents
    count: number;
    user_id?: string;
  }>;
  yes_asks: Array<{
    price: number;
    count: number;
    user_id?: string;
  }>;
}

// Store credentials in memory (would use secure storage in production)
let authToken: string | null = null;
let apiKey: string | null = null;

/**
 * Initialize Kalshi with API key or credentials
 * API key is preferred (from Kalshi settings page)
 */
export function kalshiInitWithApiKey(key: string): void {
  apiKey = key;
}

/**
 * Authenticate with Kalshi (email/password fallback)
 * Returns JWT token or throws
 */
export async function kalshiAuth(creds?: KalshiCredentials): Promise<string> {
  // Prefer API key if provided
  if (creds?.apiKey) {
    apiKey = creds.apiKey;
    return creds.apiKey;
  }

  if (!creds?.email || !creds?.password) {
    throw new Error("Kalshi credentials required. Set KALSHI_API_KEY or KALSHI_EMAIL/KALSHI_PASSWORD");
  }

  const response = await fetch(`${KALSHI_API}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: creds.email,
      password: creds.password,
    }),
  });

  if (!response.ok) {
    throw new Error(`Kalshi auth failed: ${response.status}`);
  }

  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new Error("Kalshi auth failed: missing token in response");
  }
  authToken = data.token;
  return data.token;
}

/**
 * Get auth header or throw if not authenticated
 */
function getAuthHeader(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  } else {
    throw new Error("Not authenticated with Kalshi. Call kalshiInitWithApiKey() or kalshiAuth() first");
  }

  return headers;
}

/**
 * Check if Kalshi is authenticated
 */
export function isKalshiAuthenticated(): boolean {
  return apiKey !== null || authToken !== null;
}

/**
 * Fetch all active markets from Kalshi
 * BRD: Market discovery
 */
export async function fetchKalshiMarkets(
  limit = 100
): Promise<KalshiMarketResponse> {
  // Note: Some endpoints may be public; auth required for trading data
  const url = `${KALSHI_API}/markets?limit=${limit}&status=open`;

  const headers = authToken ? getAuthHeader() : {};
  const response = await fetch(url, { headers });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Kalshi authentication required");
    }
    throw new Error(`Kalshi API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch specific market by ticker
 */
export async function fetchKalshiMarket(
  ticker: string
): Promise<KalshiMarket | null> {
  const url = `${KALSHI_API}/markets/${ticker}`;

  const headers = authToken ? getAuthHeader() : {};
  const response = await fetch(url, { headers });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Kalshi error fetching ${ticker}: ${response.status}`);
  }

  const data = await response.json();
  return data.market;
}

/**
 * Fetch order book for a market
 * BRD: Pull bid, ask, depth
 */
export async function fetchKalshiBook(
  ticker: string
): Promise<KalshiOrderBook> {
  const url = `${KALSHI_API}/markets/${ticker}/orderbook`;

  const headers = getAuthHeader();
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Kalshi book error: ${response.status}`);
  }

  return response.json();
}

/**
 * Convert Kalshi cents to decimal probability [0..1]
 */
function centsToProb(cents: number): number {
  return Math.max(0, Math.min(1, cents / 100));
}

/**
 * Build normalized snapshot from Kalshi market
 * BRD 5.1: bid, ask, spread, depth, volume, midpoint
 */
function normalizeKalshiMarket(
  ticker: string,
  market: KalshiMarket,
  book?: KalshiOrderBook
): NormalizedSnapshot {
  const bid = centsToProb(market.yes_bid);
  const ask = centsToProb(market.yes_ask);

  // Depth: sum of top level orders if book available, else estimate
  let depth = 1000; // fallback
  if (book && book.yes_bids[0] && book.yes_asks[0]) {
    depth = Math.min(book.yes_bids[0].count, book.yes_asks[0].count);
  }

  return {
    venue: "KALSHI",
    marketId: ticker,
    ts: Date.now(),
    top: { bid, ask },
    depthAtBest: depth,
    volume24h: market.volume || 0,
    midpoint: utilMidpoint(bid, ask),
    spread: ask - bid,
  };
}

/**
 * Fetch live Kalshi snapshot (main entry point)
 * BRD 11: Live adapter
 */
export async function fetchKalshiSnapshot(
  ticker: string
): Promise<NormalizedSnapshot | null> {
  const start = Date.now();

  try {
    // Ensure authenticated
    if (!authToken) {
      // Try to auth from env
      const email = process.env.KALSHI_EMAIL;
      const password = process.env.KALSHI_PASSWORD;
      if (email && password) {
        await kalshiAuth({ email, password });
      } else {
        throw new Error("Kalshi credentials not configured");
      }
    }

    // Fetch market + order book in parallel
    const [market, book] = await Promise.all([
      fetchKalshiMarket(ticker),
      fetchKalshiBook(ticker).catch(() => undefined), // Book may fail, tolerate
    ]);

    if (!market) {
      console.log(`[Kalshi] Market ${ticker} not found`);
      return null;
    }

    const snapshot = normalizeKalshiMarket(ticker, market, book);

    const latency = Date.now() - start;
    if (latency > 3000) {
      console.warn(`[Kalshi] Latency ${latency}ms exceeds 3000ms`);
    }

    return snapshot;
  } catch (error) {
    console.error(`[Kalshi] Error fetching ${ticker}:`, error);
    return null;
  }
}

/**
 * Find Kalshi market by title fragment
 */
export async function findKalshiByQuestion(
  fragment: string
): Promise<NormalizedSnapshot | null> {
  try {
    // This requires public markets endpoint or auth
    const response = await fetchKalshiMarkets(200);

    const market = response.markets.find((m) =>
      m.title.toLowerCase().includes(fragment.toLowerCase())
    );

    if (!market) return null;

    return normalizeKalshiMarket(market.ticker, market);
  } catch (error) {
    console.error("[Kalshi] Find error:", error);
    return null;
  }
}

/**
 * Batch fetch Kalshi markets
 * BRD: Support 50+ concurrent
 */
export async function fetchKalshiBatched(
  tickers: string[]
): Promise<Map<string, NormalizedSnapshot>> {
  const results = new Map<string, NormalizedSnapshot>();

  // Process in batches of 5
  const batchSize = 5;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (ticker) => {
        try {
          const snapshot = await fetchKalshiSnapshot(ticker);
          return { ticker, snapshot };
        } catch (e) {
          return { ticker, snapshot: null };
        }
      })
    );

    for (const { ticker, snapshot } of batchResults) {
      if (snapshot) results.set(ticker, snapshot);
    }

    // Rate limit delay
    if (i + batchSize < tickers.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
