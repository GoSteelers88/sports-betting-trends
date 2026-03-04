/**
 * Convergence Engine CLI
 * Run: npm run dev
 *
 * BRD Architecture: Ingest → Normalize → Validate → Weight → Fair Value →
 *                   Friction → Edge → Threshold → Risk Governor → Signal
 */

import { discoverMarket as fetchPair } from "./ingestion";
import { validateMapping } from "./validation";
import { computeEdge } from "./edge";
import { dynamicThreshold } from "./threshold";
import { checkSystemHealth, createSystemHealth } from "./failureModes";
import { checkExposure, createRiskState } from "./riskGovernor";
import { computePositionSize } from "./positionSizing";
import {
  addTrade,
  closeTrade,
  computeBacktestMetrics,
  createBacktestResult,
} from "./backtest";
import { MarketMapping, Signal } from "./types";
import { config } from "./config";

// Example market mapping
const exampleMapping: MarketMapping = {
  mappingId: "demo-001",
  kalshiMarketId: "T.BIN.001",
  kalshiResolutionText: "Will Trump win 2024?",
  kalshiExpiryTs: Date.now() + 72 * 60 * 60 * 1000, // 72h
  equivalenceScore: 0.95,
  validated: true,
};

async function runEngine() {
  console.log("=== Convergence Engine - Demo Run ===\n");

  // 1. Health check (BRD 5.9)
  const health = createSystemHealth();
  const healthCheck = checkSystemHealth(health);
  if (!healthCheck.healthy) {
    console.log("[BLOCKED] System unhealthy:", healthCheck.reasons.join("; "));
    return;
  }

  // 2. Ingest (BRD 5.1)
  const result = await fetchPair(
    exampleMapping.kalshiResolutionText,
    exampleMapping.kalshiMarketId
  );
  const kalshi = result.kalshi;
  if (!kalshi) {
    console.log("[BLOCKED] Failed to fetch Kalshi market");
    return;
  }

  // 3. Validate mapping (BRD 5.2)
  const validation = validateMapping(exampleMapping);
  if (!validation.valid) {
    console.log("[BLOCKED] Mapping invalid:", validation.reasons.join("; "));
    return;
  }

  // 4. Compute edge (BRD 5.5)
  const edgeResult = computeEdge(kalshi, kalshi, {
    convergenceRate: 0.85,
  });

  // 5. Dynamic threshold (BRD 5.6)
  const hoursToExpiry = 72;
  const spreadWidening = kalshi.spread > config.liquidity.spreadThreshold;
  const threshold = dynamicThreshold(
    edgeResult.reliability,
    spreadWidening,
    hoursToExpiry
  );

  // 6. Signal decision
  const action: Signal["action"] =
    edgeResult.finalEdge > threshold ? "FLAG" : "PASS";

  const signal: Signal = {
    mappingId: exampleMapping.mappingId,
    action,
    finalEdge: edgeResult.finalEdge,
    threshold,
    reasons: [],
    timestamp: Date.now(),
    marketId: kalshi.marketId,
    venue: kalshi.venue,
    bid: kalshi.top.bid,
    ask: kalshi.top.ask,
    spread: kalshi.spread,
    depth: kalshi.depthAtBest,
    volume: kalshi.volume24h,
    midpoint: kalshi.midpoint,
    fairValue: edgeResult.pFair,
    edge: edgeResult.finalEdge,
  };

  // 7. Risk governor check (BRD 5.7)
  if (action === "FLAG") {
    const risk = createRiskState();
    const position = computePositionSize(
      edgeResult.finalEdge,
      edgeResult.pFair,
      kalshi,
      kalshi,
      10000 // $10k bankroll
    );

    const exposure = position.capped / 10000;
    const check = checkExposure(risk, signal, "trump-events", "2024-election", exposure);

    if (!check.allowed) {
      signal.action = "BLOCKED";
      signal.reasons.push(...check.reasons);
    } else {
      signal.reasons.push("Edge above threshold", "Risk approved");
    }
  } else {
    signal.reasons.push("Final edge below threshold");
  }

  // Output
  console.log("\n--- Results ---");
  console.log("Raw diff:", (edgeResult.rawDiff * 100).toFixed(2) + "%");
  console.log("Friction:", (edgeResult.friction * 100).toFixed(2) + "%");
  console.log("Adj edge:", (edgeResult.adjEdge * 100).toFixed(2) + "%");
  console.log("Reliability:", (edgeResult.reliability * 100).toFixed(1) + "%");
  console.log("Final edge:", (edgeResult.finalEdge * 100).toFixed(2) + "%");
  console.log("Threshold:", (threshold * 100).toFixed(2) + "%");
  console.log("Fair value:", (edgeResult.pFair * 100).toFixed(1) + "%");
  console.log("Signal:", signal.action);
  console.log("Reasons:", signal.reasons.join("; ") || "N/A");

  // Backtest demo
  console.log("\n--- Backtest Demo ---");
  let bt = createBacktestResult();
  bt = addTrade(bt, signal, kalshi.midpoint);

  const exitPrice = kalshi.midpoint;
  bt = closeTrade(bt, 0, exitPrice);
  bt = computeBacktestMetrics(bt);

  console.log("Total trades:", bt.totalTrades);
  console.log("Win rate:", (bt.winRate * 100).toFixed(1) + "%");
  console.log("Avg net edge:", (bt.avgNetEdge * 100).toFixed(2) + "%");
  console.log("Sharpe:", bt.sharpeRatio.toFixed(2));
  console.log("Max DD:", (bt.maxDrawdown * 100).toFixed(1) + "%");

  console.log("\n=== Done ===");
}

runEngine().catch(console.error);
