/**
 * Live Monitor CLI
 * Polls Polymarket every 30s, surfaces edge > threshold
 * Optional: Compare with Kalshi if configured
 *
 * Run: POLL_INTERVAL_MS=30000 npm run dev:monitor
 * Or:  KALSHI_API_KEY=xxx npm run dev:monitor
 */

import { fetchPolymarketSnapshot, fetchPolymarketBatched, fetchGammaMarkets } from "../adapters/polymarketAdapter.js";
import { fetchKalshiSnapshot, kalshiInitWithApiKey, isKalshiAuthenticated } from "../adapters/kalshiAdapter.js";
import { computeEdge } from "../edge.js";
import { liquidityConfidence } from "../liquidity.js";
import { dynamicThreshold } from "../threshold.js";
import { createSystemHealth, checkSystemHealth } from "../failureModes.js";
import type { NormalizedSnapshot, Signal, SignalAction } from "../types.js";

import * as fs from "fs";
import * as path from "path";

// Config from env
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "30000");
const THRESHOLD_OVERRIDE = parseFloat(process.env.THRESHOLD_OVERRIDE || "0");
const LOG_DIR = process.env.LOG_DIR || "./logs";
const MAX_POSITION_USD = parseInt(process.env.MAX_POSITION_USD || "1000");

// Initialize Kalshi if key provided
const KALSHI_KEY = process.env.KALSHI_API_KEY;
if (KALSHI_KEY) {
  kalshiInitWithApiKey(KALSHI_KEY);
  console.log("[Kalshi] API key configured");
}

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFile = path.join(LOG_DIR, `monitor-${new Date().toISOString().split("T")[0]}.csv`);

// CSV header
const CSV_HEADER = "timestamp,market_id,venue,bid,ask,midpoint,spread,depth,volume24h,liq_conf,edge,threshold,signal,reasons\n";
if (!fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, CSV_HEADER);
}

interface MonitoredMarket {
  conditionId: string;
  question: string;
  category: string;
  kalshiTicker?: string;
}

// Markets from AGENTS.md - will be expanded with real conditionIds
const MONITORED: MonitoredMarket[] = [
  { conditionId: "0x0000000000000000000000000000000000000000", question: "Placeholder - discovery mode", category: "discovery" },
];

interface MonitorResult {
  ts: number;
  market: MonitoredMarket;
  poly: NormalizedSnapshot | null;
  kalshi: NormalizedSnapshot | null;
  signal?: Signal;
}

/**
 * Discover top liquid markets from Polymarket
 */
async function discoverMarkets(limit = 20): Promise<MonitoredMarket[]> {
  console.log(`\n🔍 Discovering top ${limit} markets...`);

  try {
    const gammaMarkets = await fetchGammaMarkets(limit);

    return gammaMarkets.map(m => ({
      conditionId: m.conditionId,
      question: m.question,
      category: m.category,
    }));
  } catch (e) {
    console.error("Discovery failed:", e instanceof Error ? e.message : "");
    return MONITORED;
  }
}

/**
 * Calculate edge and generate signal
 */
function generateSignal(
  market: MonitoredMarket,
  poly: NormalizedSnapshot,
  kalshi?: NormalizedSnapshot | null
): Signal | null {
  // Calculate liquidity confidence
  const liqConf = liquidityConfidence(poly, poly.depthAtBest * 2, poly.volume24h * 2);

  // Calculate edge (if Kalshi available, cross-venue; else use fair value from book)
  let edgeResult;
  if (kalshi) {
    edgeResult = computeEdge(poly, kalshi, { convergenceRate: 0.85 });
  } else {
    // Single venue: compare to fair value from order book
    const fairValue = poly.midpoint;
    edgeResult = {
      rawDiff: Math.abs(poly.midpoint - fairValue),
      friction: poly.spread / 2, // Half spread as friction
      adjEdge: poly.spread / 2,
      reliability: liqConf,
      finalEdge: (poly.spread / 2) * liqConf,
      pFair: fairValue,
    };
  }

  // Dynamic threshold
  const hoursToExpiry = 72; // Placeholder - would parse from market data
  const spreadWidening = poly.spread > 0.03;
  const threshold = THRESHOLD_OVERRIDE > 0
    ? THRESHOLD_OVERRIDE
    : dynamicThreshold(liqConf, spreadWidening, hoursToExpiry);

  // Generate signal
  const action: SignalAction = edgeResult.finalEdge > threshold ? "FLAG" : "PASS";

  const reasons: string[] = [];
  if (action === "FLAG") {
    if (kalshi) {
      const diff = Math.abs(poly.midpoint - kalshi.midpoint);
      reasons.push(`Cross-venue diff: ${(diff * 100).toFixed(1)}%`);
    }
    reasons.push(`Edge ${(edgeResult.finalEdge * 100).toFixed(2)}% vs threshold ${(threshold * 100).toFixed(2)}%`);
  }

  return {
    mappingId: market.conditionId,
    action,
    finalEdge: edgeResult.finalEdge,
    threshold,
    reasons,
    timestamp: Date.now(),
    marketId: poly.marketId,
    venue: poly.venue,
    bid: poly.top.bid,
    ask: poly.top.ask,
    spread: poly.spread,
    depth: poly.depthAtBest,
    volume: poly.volume24h,
    midpoint: poly.midpoint,
    fairValue: edgeResult.pFair,
    edge: edgeResult.finalEdge,
  };
}

/**
 * Log snapshot to CSV
 */
function logSnapshot(poly: NormalizedSnapshot, kalshi: NormalizedSnapshot | null, signal?: Signal) {
  const row = [
    new Date(poly.ts).toISOString(),
    poly.marketId,
    poly.venue,
    poly.top.bid.toFixed(4),
    poly.top.ask.toFixed(4),
    poly.midpoint.toFixed(4),
    poly.spread.toFixed(4),
    poly.depthAtBest.toFixed(0),
    poly.volume24h.toFixed(0),
    signal ? signal.edge.toFixed(4) : "",
    signal ? signal.threshold.toFixed(4) : "",
    signal ? signal.action : "",
    signal ? `"${signal.reasons.join("; ")}"` : "",
  ].join(",") + "\n";

  fs.appendFileSync(logFile, row);
}

/**
 * Poll a single market
 */
async function pollMarket(market: MonitoredMarket): Promise<MonitorResult> {
  const start = Date.now();

  // Fetch both venues in parallel
  const [poly, kalshi] = await Promise.all([
    fetchPolymarketSnapshot(market.conditionId).catch(() => null),
    market.kalshiTicker && isKalshiAuthenticated()
      ? fetchKalshiSnapshot(market.kalshiTicker).catch(() => null)
      : Promise.resolve(null),
  ]);

  const latency = Date.now() - start;

  if (!poly) {
    return { ts: start, market, poly: null, kalshi: null };
  }

  // Generate signal
  const signal = kalshi
    ? generateSignal(market, poly, kalshi)
    : generateSignal(market, poly, null);

  // Log
  logSnapshot(poly, kalshi, signal || undefined);

  return { ts: start, market, poly, kalshi, signal: signal || undefined };
}

/**
 * Run one poll cycle
 */
async function pollCycle(markets: MonitoredMarket[]) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 Poll cycle at ${new Date().toISOString()}`);
  console.log(`Monitoring ${markets.length} markets | Log: ${logFile}`);

  // Health check
  const health = createSystemHealth();
  const healthCheck = checkSystemHealth(health);
  if (!healthCheck.healthy) {
    console.error("❌ System unhealthy:", healthCheck.reasons.join("; "));
    return;
  }

  // Poll all markets (batched)
  const batchSize = 5;
  const results: MonitorResult[] = [];

  for (let i = 0; i < markets.length; i += batchSize) {
    const batch = markets.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(m => pollMarket(m)));
    results.push(...batchResults);

    // Rate limit delay between batches
    if (i + batchSize < markets.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Display results
  console.log("\n--- Results ---");
  let flags = 0;

  for (const result of results) {
    if (!result.poly) {
      console.log(`❌ ${result.market.question.slice(0, 50)}... - No data`);
      continue;
    }

    const poly = result.poly;
    const kalshi = result.kalshi;
    const signal = result.signal;

    const icon = signal?.action === "FLAG" ? "🚨 FLAG" : "✓";
    if (signal?.action === "FLAG") flags++;

    const edgePct = signal ? `${(signal.edge * 100).toFixed(2)}%` : "n/a";
    const thresholdPct = signal ? `${(signal.threshold * 100).toFixed(2)}%` : "n/a";
    const spreadPct = `${(poly.spread * 100).toFixed(2)}%`;

    console.log(`${icon} ${result.market.question.slice(0, 70)} | edge=${edgePct} threshold=${thresholdPct} spread=${spreadPct}`);
  }

  console.log(`\nFlags this cycle: ${flags}/${results.length}`);
}

async function main() {
  console.log("🚀 Starting live monitor...");
  const discovered = await discoverMarkets(20);
  let markets = discovered.length ? discovered : MONITORED;

  await pollCycle(markets);

  setInterval(async () => {
    try {
      await pollCycle(markets);
    } catch (err) {
      console.error("poll cycle failed", err);
    }
  }, POLL_INTERVAL);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});