/**
 * run-kalshi-autopilot-ws.ts â WebSocket-Driven Information-Speed Autopilot
 *
 * âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 * WHY WS OVER POLLING:
 *   Polling (30s): You learn of a price move 0â30 seconds late.
 *   WebSocket:     You learn of a price move in <100ms.
 *
 *   The information-speed edge only exists in the first few seconds after
 *   Poly leads. By the time the poll fires, arbitrageurs have already closed
 *   the gap. WS captures the edge before it disappears.
 *
 * ARCHITECTURE:
 *   â¢ Kalshi WS  â wss://trading-api.kalshi.com/trade-api/ws/v2
 *                  channels: orderbook_snapshot + orderbook_delta
 *                  auth: RSA-PKCS1v15-SHA256 signed timestamp
 *   â¢ Poly WS    â wss://ws-subscriptions-clob.polymarket.com/ws/market
 *                  subscribe: { assets_ids: [...], type: "Market" }
 *   â¢ Trade exec â Kalshi REST (same execute-kalshi.ts as polling version)
 *   â¢ Exits      â REST-polled every 30s (no WS needed for fills)
 *
 * STARTUP FLOW:
 *   1. Load markets from data/processed/latest-kalshi.json
 *   2. Fuzzy-match each market to a Polymarket token via gamma API
 *      (cached in data/processed/poly-market-map.json)
 *   3. Connect Kalshi WS â login â subscribe orderbook_snapshot + orderbook_delta
 *   4. Connect Poly WS â subscribe to matched token IDs
 *   5. On every price event â update state â checkSignal(ticker) immediately
 *   6. Background: exit loop polls REST every 30s for fills
 *
 * SIGNAL LOGIC (identical to polling version):
 *   â¢ detectLeader() â Granger-style lead-lag scoring
 *   â¢ ONLY trade when POLY leads (KALSHI leads: 57W-397L = poison)
 *   â¢ confirmMomentum() â sustained directional move, not noise
 *   â¢ Kelly sizing with 7% Kalshi fee baked in
 *   â¢ Per-market loss limit: -$500
 *   â¢ 5-second signal debounce per market (prevent signal storms)
 *
 * ENV:
 *   KALSHI_API_KEY_ID           â RSA key ID
 *   KALSHI_PRIVATE_KEY_PEM_PATH â path to RSA private key PEM
 *   KALSHI_AUTOPILOT_STOP=1     â env var kill switch
 *
 * INSTALL:
 *   npm install ws @types/ws
 *   npx tsx scripts/run-kalshi-autopilot-ws.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  KalshiOrder,
  KalshiPosition,
  cancelAllRestingOrders,
  cancelOrder,
  createOrder,
  getBalance,
  getOrders,
  getPositions,
} from "./execute-kalshi.js";

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Constants
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const KALSHI_WS_URL = "wss://trading-api.kalshi.com/trade-api/ws/v2";
const POLY_WS_URL   = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_API     = "https://gamma-api.polymarket.com/markets";

// Safety caps (same as polling version)
const MAX_COST_PER_ORDER_USD  = 2.00;
const MAX_TOTAL_EXPOSURE_USD  = 20.00;
const MAX_OPEN_POSITIONS      = 5;
const MAX_RESTING_ORDERS      = 5;
const MAX_ORDERS_PER_HOUR     = 20;

// Edge thresholds
const EDGE_THRESHOLD_PCT      = 5;
const HIGH_EDGE_THRESHOLD_PCT = 10;
const DEFAULT_COST_USD        = 1.00;
const HIGH_EDGE_COST_USD      = 2.00;

// Loss / timing limits
const MARKET_LOSS_LIMIT_USD   = -500;
const ENTRY_COOLDOWN_MS       = 300_000;  // 5 min cooldown after entry attempt
const ENTRY_TIMEOUT_SEC       = 28_800;   // 8h to fill
const EXIT_TIMEOUT_SEC        = 900;      // 15 min exit window
const TP_CENTS                = 1;        // take-profit target (+1Â¢)
const RUN_DURATION_MS         = 172_800_000; // 48h max session

// WS config
const SIGNAL_DEBOUNCE_MS          = 5_000;    // min ms between checks per market
const EXIT_POLL_INTERVAL_MS       = 30_000;   // REST exit poll
const STATUS_INTERVAL_LOOPS       = 60;        // status every ~5min (60 Ã 5s)
const WS_RECONNECT_INITIAL_MS     = 2_000;
const WS_RECONNECT_MAX_MS         = 60_000;
const WS_PING_INTERVAL_MS         = 30_000;   // keepalive ping
const PRICE_HISTORY_MAX           = 50;        // ticks per market
const ORDERBOOK_DEPTH             = 10;        // track top-N price levels

// File paths
const STOP_FILE      = path.resolve(process.cwd(), "data", "STOP_KALSHI_AUTOPILOT.txt");
const STATE_FILE     = path.resolve(process.cwd(), "data", "processed", "kalshi-state-ws.json");
const TRADES_FILE    = path.resolve(process.cwd(), "data", "processed", "kalshi-trades-ws.jsonl");
const MARKETS_FILE   = path.resolve(process.cwd(), "data", "processed", "latest-kalshi.json");
const POLY_MAP_FILE  = path.resolve(process.cwd(), "data", "processed", "poly-market-map.json");

// Discord gateway (same as polling version)
const GATEWAY_URL    = "http://127.0.0.1:18789/tools/invoke";
const GATEWAY_TOKEN  = "9f3c7ab1d2e84f16b5c0a7d43e9f2c1867b4d0ac53e18f92";
const DISCORD_CHANNEL = "channel:1474075668135284827";

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Types
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface CrossEdge {
  modelConfidence: number;
  kalshiImplied: number;
  gap: number;
  direction: "model-higher" | "model-lower";
}

interface ProcessedMarket {
  ticker: string;
  title: string;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
  impliedProbYes: number;
  status: string;
  crossEdge?: CrossEdge | null;
}

/** Per-market orderbook (price_cents â quantity). YES side = buy-YES orders. NO side = buy-NO orders. */
interface Orderbook {
  yes: Map<number, number>;  // price_cents â qty (sorted by price desc = bids)
  no:  Map<number, number>;  // price_cents â qty
}

/** Runtime state for a tracked market */
interface MarketState {
  ticker: string;
  title: string;
  polyTokenId: string | null;
  // Live prices (0â1 fraction)
  kalshiMid: number;
  kalshiYesBid: number;   // best YES bid (buy YES)
  kalshiYesAsk: number;   // best YES ask (sell YES = best NO bid complement)
  polyMid: number;
  polyBestBid: number;
  polyBestAsk: number;
  // Price history for leader detection
  priceHistory: { ts: number; polyMid: number; kalshiMid: number }[];
  // Timing
  lastSignalCheck: number;
  receivedKalshiSnapshot: boolean;
}

interface LeaderDetectionResult {
  leader: "POLY" | "KALSHI" | "UNKNOWN";
  confidence: number;
  direction: "UP" | "DOWN" | "FLAT";
  magnitude: number;
  momentumConfirmed: boolean;
  momentumStrength: number;
}

interface PendingEntry {
  ticker: string;
  orderId: string;
  clientOrderId: string;
  side: "yes" | "no";
  priceCents: number;
  countFp: string;
  costUsd: number;
  placedTs: string;
  dedupeKey: string;
  edgePct: number;
  leaderAtEntry?: "POLY" | "KALSHI" | "UNKNOWN";
  directionAtEntry?: "UP" | "DOWN" | "FLAT";
}

interface PositionState {
  ticker: string;
  side: "yes" | "no";
  entryPriceCents: number;
  countFp: string;
  costUsd: number;
  entryOrderId: string;
  exitOrderId?: string;
  entryFillTs: string;
  exitAttempts: number;
  status: "awaiting_exit" | "exit_placed" | "holding_illiquid";
  leaderAtEntry?: "POLY" | "KALSHI" | "UNKNOWN";
  directionAtEntry?: "UP" | "DOWN" | "FLAT";
}

interface AutopilotState {
  startIso: string;
  realizedPnlUsd: number;
  ordersInLastHour: string[];
  consecutiveLosses: number;
  lastError: string | null;
  lastTradeIso: string | null;
  apiErrors: string[];
  pendingEntries: Record<string, PendingEntry>;
  openPositions: Record<string, PositionState>;
  entryCooldowns: Record<string, number>;
  marketCumulativePnl: Record<string, number>;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Global State
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const markets          = new Map<string, MarketState>();    // ticker â state
const orderbooks       = new Map<string, Orderbook>();      // ticker â book
const polyTokenToTicker = new Map<string, string>();         // poly token â ticker

let state: AutopilotState = {
  startIso: new Date().toISOString(),
  realizedPnlUsd: 0,
  ordersInLastHour: [],
  consecutiveLosses: 0,
  lastError: null,
  lastTradeIso: null,
  apiErrors: [],
  pendingEntries: {},
  openPositions: {},
  entryCooldowns: {},
  marketCumulativePnl: {},
};

let kalshiWs: WebSocket | null = null;
let polyWs:   WebSocket | null = null;
let kalshiPingTimer: ReturnType<typeof setInterval> | null = null;
let polyPingTimer:   ReturnType<typeof setInterval> | null = null;
let kalshiReconnectDelay = WS_RECONNECT_INITIAL_MS;
let polyReconnectDelay   = WS_RECONNECT_INITIAL_MS;
let wsMessageId = 1;
let running = true;
const placingTickers = new Set<string>(); // per-market mutex for order placement

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Utility
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function uuidv4(): string { return crypto.randomUUID(); }

function nowET(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function log(...args: unknown[]): void {
  console.log(`[ws ${nowET()}]`, ...args);
}

function warn(...args: unknown[]): void {
  console.warn(`[ws ${nowET()}] â ï¸`, ...args);
}

function isKillSwitchSet(): boolean {
  if (process.env.KALSHI_AUTOPILOT_STOP === "1") return true;
  return fs.existsSync(STOP_FILE);
}

function saveState(): void {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* ignore */ }
}

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as AutopilotState;
      state = { ...state, ...saved };
      log(`ð Loaded state: PnL=$${state.realizedPnlUsd.toFixed(2)} positions=${Object.keys(state.openPositions).length}`);
    }
  } catch { /* ignore */ }
}

function notifyDiscord(message: string): void {
  fetch(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "message", action: "send",
      args: { channel: "discord", target: DISCORD_CHANNEL, message },
      sessionKey: "main",
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch((err) => warn(`Discord failed: ${(err as Error).message}`));
}

function appendTrade(record: Record<string, unknown>): void {
  try {
    fs.appendFileSync(TRADES_FILE, JSON.stringify({ ...record, ts: new Date().toISOString() }) + "\n");
  } catch { /* ignore */ }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Kalshi Auth (RSA-PKCS1v15-SHA256)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function buildKalshiLoginParams(): { api_key: string; signature: string; timestamp: string } {
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PEM_PATH;
  if (!keyPath) throw new Error("KALSHI_PRIVATE_KEY_PEM_PATH not set");
  const api_key = process.env.KALSHI_API_KEY_ID ?? "";
  if (!api_key) throw new Error("KALSHI_API_KEY_ID not set");

  const timestamp = String(Date.now());
  const pem = fs.readFileSync(keyPath, "utf8");
  const privateKey = crypto.createPrivateKey(pem);

  // Kalshi WS signs the bare timestamp (same key material as REST, different message)
  const sig = crypto.sign(
    "SHA256",
    Buffer.from(timestamp),
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
  );

  return { api_key, signature: sig.toString("base64"), timestamp };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Orderbook Helpers
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function getOrCreateOrderbook(ticker: string): Orderbook {
  if (!orderbooks.has(ticker)) {
    orderbooks.set(ticker, { yes: new Map(), no: new Map() });
  }
  return orderbooks.get(ticker)!;
}

/** Best yes bid (cents) = max price in yes side */
function bestYesBid(ob: Orderbook): number {
  if (ob.yes.size === 0) return 0;
  return Math.max(...ob.yes.keys());
}

/** Best yes ask (cents) = 100 â max price in no side */
function bestYesAsk(ob: Orderbook): number {
  if (ob.no.size === 0) return 100;
  return 100 - Math.max(...ob.no.keys());
}

function updateMktFromOrderbook(ticker: string): void {
  const ms = markets.get(ticker);
  if (!ms) return;
  const ob = getOrCreateOrderbook(ticker);
  const bid = bestYesBid(ob);
  const ask = bestYesAsk(ob);
  if (bid > 0) ms.kalshiYesBid = bid / 100;
  if (ask < 100) ms.kalshiYesAsk = ask / 100;
  if (bid > 0 && ask < 100) ms.kalshiMid = (bid + ask) / 200;
  else if (bid > 0) ms.kalshiMid = bid / 100;
  else if (ask < 100) ms.kalshiMid = ask / 100;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Leader Detection (identical to polling version, ported from kalshi_speed_bot.py)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function detectLeader(
  polyPrices: number[],
  kalshiPrices: number[],
  lookback = 8,
): LeaderDetectionResult {
  const EMPTY: LeaderDetectionResult = {
    leader: "UNKNOWN", confidence: 0, direction: "FLAT",
    magnitude: 0, momentumConfirmed: false, momentumStrength: 0,
  };

  if (polyPrices.length < lookback + 2 || kalshiPrices.length < lookback + 2) return EMPTY;

  const polyW   = polyPrices.slice(-lookback);
  const kalshiW = kalshiPrices.slice(-lookback);

  const polyR:   number[] = [];
  const kalshiR: number[] = [];
  for (let i = 1; i < polyW.length; i++) {
    polyR.push(polyW[i] - polyW[i - 1]);
    kalshiR.push(kalshiW[i] - kalshiW[i - 1]);
  }
  if (polyR.length < 2) return EMPTY;

  // Signal 1: Lead-lag correlation (weight 0.5)
  let polyLeads = 0; let kalshiLeads = 0;
  for (let i = 0; i < polyR.length - 1; i++) {
    if (polyR[i] !== 0 && kalshiR[i + 1] !== undefined &&
        Math.sign(polyR[i]) === Math.sign(kalshiR[i + 1])) polyLeads++;
    if (kalshiR[i] !== 0 && polyR[i + 1] !== undefined &&
        Math.sign(kalshiR[i]) === Math.sign(polyR[i + 1])) kalshiLeads++;
  }
  const total1 = polyLeads + kalshiLeads;
  const s1 = total1 > 0 ? (polyLeads - kalshiLeads) / total1 : 0;

  // Signal 2: First-mover (weight 0.3)
  let polyFirst = 0; let kalshiFirst = 0;
  for (let i = 0; i < polyR.length; i++) {
    const pm = Math.abs(polyR[i]), km = Math.abs(kalshiR[i]);
    if (pm > 0.005 && km < 0.002) polyFirst++;
    else if (km > 0.005 && pm < 0.002) kalshiFirst++;
  }
  const total2 = polyFirst + kalshiFirst;
  const s2 = total2 > 0 ? (polyFirst - kalshiFirst) / total2 : 0;

  // Signal 3: Magnitude (weight 0.2)
  const polyMag   = polyR.reduce((s, r) => s + Math.abs(r), 0);
  const kalshiMag = kalshiR.reduce((s, r) => s + Math.abs(r), 0);
  const totalMag  = polyMag + kalshiMag;
  const s3 = totalMag > 0 ? (polyMag - kalshiMag) / totalMag : 0;

  const composite  = s1 * 0.5 + s2 * 0.3 + s3 * 0.2;
  const confidence = Math.abs(composite);

  let leader: "POLY" | "KALSHI" | "UNKNOWN" = "UNKNOWN";
  if (confidence > 0.3) leader = composite > 0 ? "POLY" : "KALSHI";

  // Direction from recent 3 Poly ticks
  const recent = polyW.slice(-3);
  const trend  = recent[recent.length - 1] - recent[0];
  const direction: "UP" | "DOWN" | "FLAT" =
    trend > 0.01 ? "UP" : trend < -0.01 ? "DOWN" : "FLAT";
  const magnitude = Math.abs(polyW[polyW.length - 1] - polyW[0]);

  // Momentum: last 3 returns all same direction and at least one large
  const last3    = polyR.slice(-3);
  const allSame  = last3.length >= 2 && last3.every(r => r * last3[0] > 0);
  const anyLarge = last3.some(r => Math.abs(r) > 0.01);
  const momentumConfirmed = allSame && anyLarge;
  const momentumStrength  = last3.reduce((s, r) => s + Math.abs(r), 0) / Math.max(1, last3.length);

  return { leader, confidence, direction, magnitude, momentumConfirmed, momentumStrength };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Kelly Sizing (Kalshi-fee-aware, same as polling version)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function computeKellySize(edgePct: number, leaderConfidence: number): { contracts: number; costUsd: number } {
  const edge   = edgePct / 100;
  const winProb = Math.min(0.75, Math.max(0.35, 0.50 + edge * leaderConfidence * 2));
  const losProb = 1 - winProb;

  const grossPerDollar = edge > 0 ? (1 - edge) / edge : 0;
  const netPerDollar   = grossPerDollar * 0.93; // 7% Kalshi fee
  if (netPerDollar <= 0) return { contracts: 0, costUsd: 0 };

  const kelly    = winProb - losProb / netPerDollar;
  const halfKelly = Math.max(0, Math.min(0.25, kelly * 0.5)); // cap at 25%

  const rawCost     = halfKelly * 50;  // $50 proxy bankroll
  const targetCost  = edgePct >= HIGH_EDGE_THRESHOLD_PCT ? HIGH_EDGE_COST_USD : DEFAULT_COST_USD;
  const clampedCost = Math.min(MAX_COST_PER_ORDER_USD, Math.max(0.50, Math.min(rawCost, targetCost)));

  const contracts = Math.max(1, Math.round(clampedCost));
  return { contracts, costUsd: clampedCost };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Safety Caps
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface CapResult { canTrade: boolean; reasons: string[]; }

function checkCaps(ticker: string): CapResult {
  const reasons: string[] = [];
  const now = Date.now();

  // Purge old hourly orders
  state.ordersInLastHour = state.ordersInLastHour.filter(
    ts => now - new Date(ts).getTime() < 3_600_000,
  );

  const openPos  = Object.keys(state.openPositions).length;
  const resting  = Object.keys(state.pendingEntries).length;
  const perHour  = state.ordersInLastHour.length;

  let totalExposure = 0;
  for (const p of Object.values(state.openPositions)) totalExposure += p.costUsd;
  for (const p of Object.values(state.pendingEntries)) totalExposure += p.costUsd;

  if (openPos  >= MAX_OPEN_POSITIONS)    reasons.push(`positions=${openPos}`);
  if (resting  >= MAX_RESTING_ORDERS)    reasons.push(`resting=${resting}`);
  if (perHour  >= MAX_ORDERS_PER_HOUR)   reasons.push(`orders/hr=${perHour}`);
  if (totalExposure >= MAX_TOTAL_EXPOSURE_USD) reasons.push(`exposure=$${totalExposure.toFixed(2)}`);

  const mktPnl = state.marketCumulativePnl[ticker] ?? 0;
  if (mktPnl <= MARKET_LOSS_LIMIT_USD)   reasons.push(`mkt-loss=$${mktPnl.toFixed(2)}`);

  const cooldown = state.entryCooldowns[ticker] ?? 0;
  if (now < cooldown) reasons.push(`cooldown=${Math.ceil((cooldown - now) / 1000)}s`);

  return { canTrade: reasons.length === 0, reasons };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Signal Check â fires on EVERY price update (debounced per market)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function checkSignal(ticker: string): void {
  if (!running || isKillSwitchSet()) return;

  const ms  = markets.get(ticker);
  if (!ms || !ms.receivedKalshiSnapshot) return;

  const now = Date.now();
  if (now - ms.lastSignalCheck < SIGNAL_DEBOUNCE_MS) return;
  ms.lastSignalCheck = now;

  // Need real Poly price (not zero / uninitialized)
  if (ms.polyMid <= 0 || ms.kalshiMid <= 0) return;

  // Record tick
  ms.priceHistory.push({ ts: now, polyMid: ms.polyMid, kalshiMid: ms.kalshiMid });
  if (ms.priceHistory.length > PRICE_HISTORY_MAX) ms.priceHistory.shift();

  // Need enough history for leader detection
  if (ms.priceHistory.length < 10) return;

  // Skip if already in or entering this market
  const inPosition = Object.values(state.openPositions).some(p => p.ticker === ticker);
  const inEntry    = Object.values(state.pendingEntries).some(p => p.ticker === ticker);
  if (inPosition || inEntry) return;

  const polyHistory   = ms.priceHistory.map(h => h.polyMid);
  const kalshiHistory = ms.priceHistory.map(h => h.kalshiMid);

  const leader = detectLeader(polyHistory, kalshiHistory);

  // POLY must lead with high confidence and confirmed momentum
  if (leader.leader !== "POLY")       return;
  if (leader.confidence < 0.4)        return;
  if (!leader.momentumConfirmed)      return;
  if (leader.direction === "FLAT")    return;

  // Edge = how far Kalshi lags behind Poly, in pct-points
  const rawEdge = (ms.polyMid - ms.kalshiMid) * 100;
  const edgePct = leader.direction === "UP" ? rawEdge : -rawEdge;
  if (edgePct < EDGE_THRESHOLD_PCT)   return;

  // Safety caps
  const caps = checkCaps(ticker);
  if (!caps.canTrade) {
    log(`â ${ticker} caps: ${caps.reasons.join(", ")}`);
    return;
  }

  // Trade direction: if poly > kalshi â kalshi should rise â buy YES
  const side: "yes" | "no" = rawEdge > 0 ? "yes" : "no";

  // Entry price: Kalshi's current best ask for YES (or best bid complement for NO)
  const entryPriceCents = side === "yes"
    ? Math.round(ms.kalshiYesAsk * 100)
    : Math.round((1 - ms.kalshiYesBid) * 100);

  if (entryPriceCents <= 0 || entryPriceCents >= 100) return;

  // Set cooldown immediately so concurrent debounces don't double-enter
  state.entryCooldowns[ticker] = now + ENTRY_COOLDOWN_MS;

  log(`ð¯ SIGNAL ${ticker} ${side.toUpperCase()} @${entryPriceCents}Â¢ edge=${edgePct.toFixed(1)}% leader=${leader.leader}(${(leader.confidence * 100).toFixed(0)}%) momentum=${leader.momentumStrength.toFixed(4)}`);

  placeEntry(ms, side, entryPriceCents, edgePct, leader)
    .catch(e => warn(`placeEntry error on ${ticker}: ${(e as Error).message}`));
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Order Placement
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function placeEntry(
  ms: MarketState,
  side: "yes" | "no",
  priceCents: number,
  edgePct: number,
  leader: LeaderDetectionResult,
): Promise<void> {
  const { ticker } = ms;
  if (placingTickers.has(ticker)) return;
  placingTickers.add(ticker);

  try {
    const dedupeKey  = `${ticker}-${side}-${priceCents}`;

    // Final dedupe check
    if (Object.values(state.pendingEntries).some(e => e.dedupeKey === dedupeKey)) return;

    const { contracts, costUsd } = computeKellySize(edgePct, leader.confidence);
    if (contracts === 0) return;

    const clientOrderId = uuidv4();

    const order = await createOrder({
      ticker,
      side,
      type: "limit",
      yesPrice: side === "yes" ? priceCents : 100 - priceCents,
      count: contracts,
      clientOrderId,
      timeInForce: "GTC",
    });

    state.pendingEntries[clientOrderId] = {
      ticker,
      orderId: order.order_id,
      clientOrderId,
      side,
      priceCents,
      countFp: String(contracts),
      costUsd,
      placedTs: new Date().toISOString(),
      dedupeKey,
      edgePct,
      leaderAtEntry:    leader.leader,
      directionAtEntry: leader.direction,
    };
    state.ordersInLastHour.push(new Date().toISOString());
    state.lastTradeIso = new Date().toISOString();
    saveState();

    const msg = `ð¯ **WS ENTRY** \`${ticker}\` ${side.toUpperCase()} @${priceCents}Â¢ | edge=${edgePct.toFixed(1)}% | ${leader.leader}(${(leader.confidence * 100).toFixed(0)}%) | $${costUsd.toFixed(2)}`;
    log(msg);
    notifyDiscord(msg);
    appendTrade({ type: "entry_placed", ticker, side, priceCents, contracts, costUsd, edgePct, leader: leader.leader });
  } catch (err) {
    warn(`createOrder failed: ${(err as Error).message}`);
  } finally {
    placingTickers.delete(ticker);
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Exit Management (REST-polled every 30s â fills confirmed via API)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function manageExits(): Promise<void> {
  try {
    const [ordersResp, positionsResp] = await Promise.all([
      getOrders({ status: "resting" }),
      getPositions(),
    ]);
    const apiOrders    = (ordersResp.orders    ?? []) as KalshiOrder[];
    const apiPositions = (positionsResp.market_positions ?? []) as KalshiPosition[];
    const now = Date.now();

    // ââ Pending entries â check fills ââââââââââââââââââââââââââââââââââââââââ
    for (const [clientId, entry] of Object.entries(state.pendingEntries)) {
      const apiOrder = apiOrders.find(o => o.client_order_id === clientId);

      // Order vanished or canceled
      if (!apiOrder || apiOrder.status === "canceled") {
        delete state.pendingEntries[clientId];
        continue;
      }

      const filled = Number(apiOrder.count_filled_fp ?? 0);
      if (filled > 0) {
        log(`â Entry filled: ${entry.ticker} ${entry.side.toUpperCase()} @${entry.priceCents}Â¢ Ã${filled}`);
        state.openPositions[clientId] = {
          ticker:         entry.ticker,
          side:           entry.side,
          entryPriceCents: entry.priceCents,
          countFp:        String(filled),
          costUsd:        entry.costUsd,
          entryOrderId:   apiOrder.order_id,
          entryFillTs:    new Date().toISOString(),
          exitAttempts:   0,
          status:         "awaiting_exit",
          leaderAtEntry:    entry.leaderAtEntry,
          directionAtEntry: entry.directionAtEntry,
        };
        delete state.pendingEntries[clientId];
        appendTrade({ type: "entry_filled", ticker: entry.ticker, side: entry.side, priceCents: entry.priceCents, filled });
      }

      // Timeout stale entries
      if (now - new Date(entry.placedTs).getTime() > ENTRY_TIMEOUT_SEC * 1000) {
        log(`â±ï¸ Canceling stale entry: ${entry.ticker}`);
        await cancelOrder(apiOrder.order_id).catch(() => null);
        delete state.pendingEntries[clientId];
      }
    }

    // ââ Open positions â manage exits ââââââââââââââââââââââââââââââââââââââââ
    for (const [posId, pos] of Object.entries(state.openPositions)) {
      const ms         = markets.get(pos.ticker);
      const currentMid = ms?.kalshiMid ?? 0.5;

      // Check if API position is closed (exited)
      const apiPos = apiPositions.find(p => (p as { market_id: string }).market_id === pos.ticker);
      if (!apiPos || Number((apiPos as { position: number }).position) === 0) {
        const pnl = (pos.side === "yes"
          ? currentMid - pos.entryPriceCents / 100
          : pos.entryPriceCents / 100 - currentMid) * Number(pos.countFp) * 100;

        state.realizedPnlUsd += pnl;
        state.marketCumulativePnl[pos.ticker] = (state.marketCumulativePnl[pos.ticker] ?? 0) + pnl;
        if (pnl < 0) state.consecutiveLosses++;
        else state.consecutiveLosses = 0;

        log(`ð° Closed: ${pos.ticker} PnL=$${pnl.toFixed(2)} | session=$${state.realizedPnlUsd.toFixed(2)}`);
        notifyDiscord(`ð° **WS CLOSED** \`${pos.ticker}\` PnL=$${pnl.toFixed(2)} | Session=$${state.realizedPnlUsd.toFixed(2)}`);
        appendTrade({ type: "position_closed", ticker: pos.ticker, side: pos.side, pnl });
        delete state.openPositions[posId];
        continue;
      }

      // Place exit if TP reached or timeout
      const timeSinceEntry = now - new Date(pos.entryFillTs).getTime();
      const unrealizedPct  = (pos.side === "yes"
        ? currentMid - pos.entryPriceCents / 100
        : pos.entryPriceCents / 100 - currentMid) * 100;
      const needsExit = unrealizedPct >= TP_CENTS || timeSinceEntry > EXIT_TIMEOUT_SEC * 1000;

      if (needsExit && pos.status === "awaiting_exit" && !pos.exitOrderId) {
        const exitPriceCents = pos.side === "yes"
          ? Math.min(99, pos.entryPriceCents + TP_CENTS)
          : Math.max(1,  pos.entryPriceCents - TP_CENTS);

        try {
          const exitOrder = await createOrder({
            ticker:        pos.ticker,
            side:          pos.side === "yes" ? "no" : "yes",
            type:          "limit",
            yesPrice:      pos.side === "yes" ? exitPriceCents : 100 - exitPriceCents,
            count:         Number(pos.countFp),
            clientOrderId: uuidv4(),
            timeInForce:   "GTC",
          });
          pos.exitOrderId   = exitOrder.order_id;
          pos.status        = "exit_placed";
          pos.exitAttempts++;
          log(`ð¤ Exit placed: ${pos.ticker} @${exitPriceCents}Â¢`);
        } catch (err) {
          warn(`Exit failed: ${(err as Error).message}`);
          pos.exitAttempts++;
          if (pos.exitAttempts > 10) pos.status = "holding_illiquid";
        }
      }
    }

    saveState();
  } catch (err) {
    warn(`manageExits error: ${(err as Error).message}`);
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Kalshi WebSocket
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface KalshiWsMsg {
  type: string;
  msg?: Record<string, unknown>;
  id?: number;
}

interface KalshiSnapshotLevel { [price: number]: number; } // price_cents â qty

function handleKalshiSnapshot(msg: Record<string, unknown>): void {
  const ticker = msg["market_ticker"] as string;
  if (!ticker || !markets.has(ticker)) return;

  const ob = getOrCreateOrderbook(ticker);
  ob.yes.clear();
  ob.no.clear();

  // Kalshi sends: { yes: [[price, qty], ...], no: [[price, qty], ...] }
  for (const [price, qty] of (msg["yes"] as [number, number][] ?? [])) {
    if (qty > 0) ob.yes.set(price, qty);
  }
  for (const [price, qty] of (msg["no"] as [number, number][] ?? [])) {
    if (qty > 0) ob.no.set(price, qty);
  }

  const ms = markets.get(ticker)!;
  ms.receivedKalshiSnapshot = true;
  updateMktFromOrderbook(ticker);
  checkSignal(ticker);
}

function handleKalshiDelta(msg: Record<string, unknown>): void {
  const ticker = msg["market_ticker"] as string;
  if (!ticker || !markets.has(ticker)) return;

  const price = msg["price"] as number;   // cents
  const delta = msg["delta"] as number;   // qty change (pos=add, neg=remove)
  const side  = msg["side"]  as "yes" | "no";

  const ob = getOrCreateOrderbook(ticker);
  const book = side === "yes" ? ob.yes : ob.no;

  if (delta > 0) {
    book.set(price, (book.get(price) ?? 0) + delta);
  } else {
    const cur = (book.get(price) ?? 0) + delta; // delta is negative
    if (cur <= 0) book.delete(price);
    else book.set(price, cur);
  }

  // Prune to top-N to prevent unbounded growth
  if (book.size > ORDERBOOK_DEPTH * 2) {
    const sorted = [...book.entries()].sort((a, b) => b[0] - a[0]).slice(0, ORDERBOOK_DEPTH);
    book.clear();
    for (const [k, v] of sorted) book.set(k, v);
  }

  updateMktFromOrderbook(ticker);
  checkSignal(ticker);
}

function subscribeKalshiChannels(): void {
  if (!kalshiWs || kalshiWs.readyState !== WebSocket.OPEN) return;
  const tickers = [...markets.keys()];
  if (tickers.length === 0) return;

  const BATCH = 50;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);

    // Subscribe to snapshot first, then deltas
    kalshiWs.send(JSON.stringify({
      id: wsMessageId++,
      cmd: "subscribe",
      params: { channels: ["orderbook_snapshot"], market_tickers: batch },
    }));
    kalshiWs.send(JSON.stringify({
      id: wsMessageId++,
      cmd: "subscribe",
      params: { channels: ["orderbook_delta"],    market_tickers: batch },
    }));
  }
  log(`ð¡ Kalshi: subscribed ${tickers.length} markets (snapshot + delta)`);
}

function startKalshiPing(): void {
  if (kalshiPingTimer) clearInterval(kalshiPingTimer);
  kalshiPingTimer = setInterval(() => {
    if (kalshiWs?.readyState === WebSocket.OPEN) {
      kalshiWs.ping();
    }
  }, WS_PING_INTERVAL_MS);
}

function connectKalshiWs(): void {
  log("ð Connecting Kalshi WS...");
  const ws = new WebSocket(KALSHI_WS_URL);
  kalshiWs = ws;

  ws.on("open", () => {
    log("â Kalshi WS open");
    kalshiReconnectDelay = WS_RECONNECT_INITIAL_MS;
    startKalshiPing();

    // Authenticate
    try {
      const loginParams = buildKalshiLoginParams();
      ws.send(JSON.stringify({ id: wsMessageId++, cmd: "login", params: loginParams }));
    } catch (err) {
      warn(`Kalshi WS auth error: ${(err as Error).message}`);
      ws.close();
    }
  });

  ws.on("message", (data: Buffer) => {
    let msg: KalshiWsMsg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case "login":
        if ((msg.msg as { code?: number })?.code === 0) {
          log("ð Kalshi WS authenticated");
          subscribeKalshiChannels();
        } else {
          warn("â Kalshi WS login failed:", JSON.stringify(msg.msg));
        }
        break;
      case "orderbook_snapshot":
        if (msg.msg) handleKalshiSnapshot(msg.msg);
        break;
      case "orderbook_delta":
        if (msg.msg) handleKalshiDelta(msg.msg);
        break;
      case "subscribed":
        // Acknowledged â no action needed
        break;
      case "error":
        warn("Kalshi WS error msg:", JSON.stringify(msg.msg));
        break;
    }
  });

  ws.on("error", (err) => warn(`Kalshi WS error: ${err.message}`));

  ws.on("close", () => {
    if (kalshiPingTimer) { clearInterval(kalshiPingTimer); kalshiPingTimer = null; }
    kalshiWs = null;
    if (!running) return;
    log(`Kalshi WS closed â reconnect in ${kalshiReconnectDelay / 1000}s`);
    setTimeout(() => {
      if (running) connectKalshiWs();
      kalshiReconnectDelay = Math.min(kalshiReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    }, kalshiReconnectDelay);
  });
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Polymarket WebSocket
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface PolyWsMsg {
  event_type: "book" | "price_change" | "tick_size_change" | "last_trade_price" | "connected" | "subscribed";
  asset_id?: string;
  market?:   string;
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
  changes?: { price: string; size: string; side: "BUY" | "SELL" }[];
  price?:   string;
}

function handlePolyBook(tokenId: string, bids: { price: string; size: string }[], asks: { price: string; size: string }[]): void {
  const ticker = polyTokenToTicker.get(tokenId);
  if (!ticker) return;
  const ms = markets.get(ticker);
  if (!ms) return;

  const bidPrices = bids.map(b => parseFloat(b.price)).filter(p => p > 0 && p < 1).sort((a, b) => b - a);
  const askPrices = asks.map(a => parseFloat(a.price)).filter(p => p > 0 && p < 1).sort((a, b) => a - b);

  if (bidPrices.length > 0) ms.polyBestBid = bidPrices[0];
  if (askPrices.length > 0) ms.polyBestAsk = askPrices[0];

  if (ms.polyBestBid > 0 && ms.polyBestAsk > 0) {
    ms.polyMid = (ms.polyBestBid + ms.polyBestAsk) / 2;
    checkSignal(ticker);
  }
}

function handlePolyPriceChange(tokenId: string, changes: PolyWsMsg["changes"]): void {
  if (!changes) return;
  const ticker = polyTokenToTicker.get(tokenId);
  if (!ticker) return;
  const ms = markets.get(ticker);
  if (!ms) return;

  for (const ch of changes) {
    const p   = parseFloat(ch.price);
    const qty = parseFloat(ch.size);
    if (ch.side === "BUY") {
      // BUY = bid side
      if (qty > 0) ms.polyBestBid = Math.max(ms.polyBestBid, p);
      else if (p >= ms.polyBestBid) ms.polyBestBid = p; // best may have moved
    } else {
      // SELL = ask side
      if (qty > 0) ms.polyBestAsk = ms.polyBestAsk === 0 ? p : Math.min(ms.polyBestAsk, p);
      else if (p <= ms.polyBestAsk) ms.polyBestAsk = 0; // best ask removed, approximate
    }
  }

  if (ms.polyBestBid > 0 && ms.polyBestAsk > 0 && ms.polyBestBid < ms.polyBestAsk) {
    ms.polyMid = (ms.polyBestBid + ms.polyBestAsk) / 2;
    checkSignal(ticker);
  }
}

function startPolyPing(): void {
  if (polyPingTimer) clearInterval(polyPingTimer);
  polyPingTimer = setInterval(() => {
    if (polyWs?.readyState === WebSocket.OPEN) polyWs.ping();
  }, WS_PING_INTERVAL_MS);
}

function connectPolyWs(): void {
  const tokenIds = [...polyTokenToTicker.keys()];
  if (tokenIds.length === 0) {
    log("â ï¸ No Poly token IDs mapped â skipping Poly WS (check gamma API discovery)");
    return;
  }

  log(`ð Connecting Poly WS (${tokenIds.length} tokens)...`);
  const ws = new WebSocket(POLY_WS_URL);
  polyWs = ws;

  ws.on("open", () => {
    log("â Poly WS open");
    polyReconnectDelay = WS_RECONNECT_INITIAL_MS;
    startPolyPing();

    // Subscribe in batches
    const BATCH = 200;
    for (let i = 0; i < tokenIds.length; i += BATCH) {
      ws.send(JSON.stringify({ assets_ids: tokenIds.slice(i, i + BATCH), type: "Market" }));
    }
    log(`ð¡ Poly: subscribed ${tokenIds.length} tokens`);
  });

  ws.on("message", (data: Buffer) => {
    let msgs: PolyWsMsg[];
    try {
      const raw = JSON.parse(data.toString());
      msgs = Array.isArray(raw) ? raw : [raw];
    } catch { return; }

    for (const msg of msgs) {
      if (!msg.asset_id && msg.event_type !== "connected") continue;
      switch (msg.event_type) {
        case "book":
          if (msg.asset_id && msg.bids && msg.asks)
            handlePolyBook(msg.asset_id, msg.bids, msg.asks);
          break;
        case "price_change":
          if (msg.asset_id && msg.changes)
            handlePolyPriceChange(msg.asset_id, msg.changes);
          break;
        case "last_trade_price":
          // Use as a rough mid update when no book update arrives
          if (msg.asset_id && msg.price) {
            const p      = parseFloat(msg.price);
            const ticker = polyTokenToTicker.get(msg.asset_id);
            if (ticker) {
              const ms = markets.get(ticker);
              if (ms && p > 0 && p < 1 && ms.polyMid === 0) {
                ms.polyMid = p;
              }
            }
          }
          break;
      }
    }
  });

  ws.on("error", (err) => warn(`Poly WS error: ${err.message}`));

  ws.on("close", () => {
    if (polyPingTimer) { clearInterval(polyPingTimer); polyPingTimer = null; }
    polyWs = null;
    if (!running) return;
    log(`Poly WS closed â reconnect in ${polyReconnectDelay / 1000}s`);
    setTimeout(() => {
      if (running) connectPolyWs();
      polyReconnectDelay = Math.min(polyReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    }, polyReconnectDelay);
  });
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Polymarket Market Discovery (gamma API â get YES token IDs)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface GammaMarket {
  condition_id:  string;
  question:      string;
  tokens:        { token_id: string; outcome: string }[];
  active:        boolean;
  closed:        boolean;
  end_date_iso?: string;
}

function titleSimilarity(a: string, b: string): number {
  const stopWords = new Set(["will", "the", "a", "an", "in", "at", "by", "for", "to", "of", "is", "be"]);
  const words = (s: string) => new Set(s.split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w)));
  const aW = words(a);
  const bW = words(b);
  if (aW.size === 0) return 0;
  let common = 0;
  for (const w of aW) { if (bW.has(w)) common++; }
  return common / aW.size;
}

async function discoverPolyMarkets(): Promise<void> {
  log("ð Discovering Polymarket counterparts...");

  // Load cache
  let polyMap: Record<string, string> = {};
  try {
    if (fs.existsSync(POLY_MAP_FILE)) {
      polyMap = JSON.parse(fs.readFileSync(POLY_MAP_FILE, "utf8"));
      log(`ð¦ ${Object.keys(polyMap).length} cached Poly mappings`);
    }
  } catch { /* ignore */ }

  const toDiscover = [...markets.entries()].filter(([t]) => !polyMap[t]);
  log(`ð Discovering ${toDiscover.length} new markets...`);

  let newMatches = 0;
  for (const [ticker, ms] of toDiscover) {
    // Build keyword from first 4 meaningful title words
    const keyword = ms.title.split(/\s+/).slice(0, 4).join(" ");
    try {
      const res = await fetch(`${GAMMA_API}?keyword=${encodeURIComponent(keyword)}&limit=10&closed=false`);
      if (!res.ok) { await sleep(300); continue; }

      const gms = await res.json() as GammaMarket[];
      const titleLower = ms.title.toLowerCase();

      for (const gm of gms) {
        if (gm.closed) continue;
        const score = titleSimilarity(titleLower, gm.question.toLowerCase());
        if (score > 0.55) {
          const yes = gm.tokens.find(t => t.outcome === "Yes");
          if (yes) {
            polyMap[ticker] = yes.token_id;
            newMatches++;
            break;
          }
        }
      }
    } catch { /* ignore */ }
    await sleep(220); // ~4.5 req/s â well under 100/min limit
  }

  // Apply map
  for (const [ticker, tokenId] of Object.entries(polyMap)) {
    const ms = markets.get(ticker);
    if (ms) {
      ms.polyTokenId = tokenId;
      polyTokenToTicker.set(tokenId, ticker);
    }
  }

  // Save updated cache
  try { fs.writeFileSync(POLY_MAP_FILE, JSON.stringify(polyMap, null, 2)); } catch { /* ignore */ }
  log(`â Poly discovery: ${newMatches} new + ${Object.keys(polyMap).length - newMatches} cached = ${polyTokenToTicker.size} total`);
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Market Loading
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function loadMarkets(): void {
  const raw = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8")) as ProcessedMarket[];
  let loaded = 0;
  for (const m of raw) {
    if (!m.crossEdge) continue;
    const s = m.status.toLowerCase();
    if (s !== "open" && s !== "active") continue;

    markets.set(m.ticker, {
      ticker: m.ticker,
      title:  m.title ?? m.ticker,
      polyTokenId:  null,
      kalshiMid:    m.yesMid  > 0 ? m.yesMid  / 100 : 0.5,
      kalshiYesBid: m.yesBid  > 0 ? m.yesBid  / 100 : 0,
      kalshiYesAsk: m.yesAsk  > 0 ? m.yesAsk  / 100 : 1,
      polyMid:      0,
      polyBestBid:  0,
      polyBestAsk:  0,
      priceHistory: [],
      lastSignalCheck:        0,
      receivedKalshiSnapshot: false,
    });
    loaded++;
  }
  log(`ð¦ Loaded ${loaded} active cross-edge markets from ${path.basename(MARKETS_FILE)}`);
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Status Reporting
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function logStatus(): void {
  const openPos      = Object.keys(state.openPositions).length;
  const pending      = Object.keys(state.pendingEntries).length;
  const polyLive     = [...markets.values()].filter(m => m.polyMid > 0).length;
  const kalshiLive   = [...markets.values()].filter(m => m.receivedKalshiSnapshot).length;
  const polyMatched  = [...markets.values()].filter(m => m.polyTokenId !== null).length;

  const kStatus = kalshiWs?.readyState === WebSocket.OPEN ? "â" : "â";
  const pStatus = polyWs?.readyState   === WebSocket.OPEN ? "â" : "â";

  log(
    `ð PnL=$${state.realizedPnlUsd.toFixed(2)} | ` +
    `pos=${openPos} pend=${pending} | ` +
    `kalshi=${kStatus} ${kalshiLive}/${markets.size} | ` +
    `poly=${pStatus} ${polyLive}/${polyMatched}/${markets.size} live`,
  );
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Main
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function main(): Promise<void> {
  log("ð Kalshi WS Autopilot starting...");
  log(`   Markets file:  ${MARKETS_FILE}`);
  log(`   State file:    ${STATE_FILE}`);
  log(`   Poly map:      ${POLY_MAP_FILE}`);

  // Validate env
  if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY_PEM_PATH) {
    console.error("â Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM_PATH");
    process.exit(1);
  }

  loadState();
  loadMarkets();

  if (markets.size === 0) {
    console.error(`â No markets loaded from ${MARKETS_FILE}`);
    process.exit(1);
  }

  // Discover Poly counterparts (uses cached map when available)
  await discoverPolyMarkets();

  // Connect WebSockets
  connectKalshiWs();
  await sleep(500);
  connectPolyWs();

  const balance = await getBalance().catch(() => null);
  const balStr  = balance ? `$${Number(balance.balance ?? 0).toFixed(2)}` : "unknown";

  notifyDiscord(
    `ð **WS Autopilot started** | ${markets.size} Kalshi | ${polyTokenToTicker.size} Poly | balance=${balStr}`,
  );
  log(`ð° Balance: ${balStr} | ${markets.size} markets | ${polyTokenToTicker.size} Poly mapped`);

  const startTime   = Date.now();
  let loopCount     = 0;
  let exitLoopCount = 0;

  while (running) {
    loopCount++;

    if (isKillSwitchSet()) {
      log("ð Kill switch detected. Shutting down...");
      running = false;
      break;
    }

    if (Date.now() - startTime > RUN_DURATION_MS) {
      log("â±ï¸ Max run duration reached. Shutting down...");
      running = false;
      break;
    }

    // Exit management every 30s
    exitLoopCount++;
    if (exitLoopCount >= EXIT_POLL_INTERVAL_MS / 5_000) {
      exitLoopCount = 0;
      await manageExits();
    }

    // Status every ~5min
    if (loopCount % STATUS_INTERVAL_LOOPS === 0) {
      logStatus();
    }

    await sleep(5_000);
  }

  // ââ Graceful shutdown âââââââââââââââââââââââââââââââââââââââââââââââââââââ
  log("ð Shutting down...");
  running = false;

  if (kalshiPingTimer) clearInterval(kalshiPingTimer);
  if (polyPingTimer)   clearInterval(polyPingTimer);
  kalshiWs?.close();
  polyWs?.close();

  await cancelAllRestingOrders().catch(() => null);
  saveState();
  notifyDiscord(`ð **WS Autopilot stopped** | Final PnL=$${state.realizedPnlUsd.toFixed(2)}`);
  log(`â Done. Session PnL=$${state.realizedPnlUsd.toFixed(2)}`);
}

// Handle SIGINT / SIGTERM gracefully
process.on("SIGINT",  () => { log("SIGINT received"); running = false; });
process.on("SIGTERM", () => { log("SIGTERM received"); running = false; });

main().catch((err) => {
  console.error("[ws-autopilot] Fatal:", err);
  process.exit(1);
});
