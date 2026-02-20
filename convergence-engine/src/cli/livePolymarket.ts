/**
 * Live Polymarket CLI
 * Demo: Fetch top markets and surface edge
 * Run: npm run dev:live
 */

import { fetchPolymarket, searchPolymarket } from "../ingestion.js";
import { fetchPolymarketSnapshot, fetchGammaMarkets } from "../adapters/polymarketAdapter.js";
import { computeEdge } from "../edge.js";
import { liquidityConfidence } from "../liquidity.js";
import { clamp01 } from "../utils.js";

async function runLiveDemo() {
  console.log("=== Live Polymarket Data ===\n");

  // Try to fetch top liquid markets
  console.log("Fetching top markets from Gamma...");

  try {
    const markets = await fetchGammaMarkets(10);
    console.log(`\nFound ${markets.length} markets:\n`);

    for (const market of markets.slice(0, 5)) {
      const snapshot = await fetchPolymarketSnapshot(market.conditionId);

      if (!snapshot) {
        console.log(`❌ ${market.question.slice(0, 60)}... - NO DATA`);
        continue;
      }

      const volume = market.volume / 1_000_000;
      const liqConf = liquidityConfidence(
        snapshot,
        snapshot.depthAtBest * 2,
        snapshot.volume24h * 2
      );

      console.log(`✅ ${market.question.slice(0, 60)}...`);
      console.log(`   Market ID: ${market.conditionId}`);
      console.log(`   YES: ${(snapshot.top.bid * 100).toFixed(1)}¢ / ${(snapshot.top.ask * 100).toFixed(1)}¢`);
      console.log(`   Mid: ${(snapshot.midpoint * 100).toFixed(1)}¢ | Spread: ${(snapshot.spread * 100).toFixed(1)}¢`);
      console.log(`   Depth: $${snapshot.depthAtBest.toFixed(0)} | Vol 24h: $${volume.toFixed(2)}M`);
      console.log(`   Liquidity Conf: ${(liqConf * 100).toFixed(0)}%`);
      console.log();
    }

    // Demo: Search for specific market
    console.log("Searching for Fed chair markets...");
    const fedSnapshot = await searchPolymarket("Fed chair");
    if (fedSnapshot) {
      console.log(`\nFed Chair Market:`);
      console.log(`  Bid: ${(fedSnapshot.top.bid * 100).toFixed(0)}¢`);
      console.log(`  Ask: ${(fedSnapshot.top.ask * 100).toFixed(0)}¢`);
      console.log(`  Depth: $${fedSnapshot.depthAtBest.toFixed(0)}`);
    } else {
      console.log("No Fed chair market found");
    }
  } catch (error) {
    console.error("Failed to fetch live data:", error);
  }
}

runLiveDemo().catch(console.error);
