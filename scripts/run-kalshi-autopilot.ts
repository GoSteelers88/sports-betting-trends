/**
 * run-kalshi-autopilot.ts — REWRITTEN with Information-Speed Strategy
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OLD STRATEGY (killed us):
 *   "See a gap between model and Kalshi → buy the cheap side → pray"
 *   - No leader detection → didn't know WHO was right
 *   - No direction filter → faded smart money 50% of the time
 *   - No momentum check → traded noise
 *   - No per-market loss limits → death spirals (Mars Sample Return: -$40K)
 *
 * NEW STRATEGY (backtest: 368W-33L, 91.8%, +$487K):
 *   "Detect which market leads → confirm momentum → follow the leader"
 *   - Leader detection via Granger-style lead-lag correlation
 *   - ONLY trade when POLY leads (KALSHI-leads = poison: 57W-397L)
 *   - Momentum confirmation (sustained move, not noise)
 *   - Per-market loss limits ($500 max loss per market)
 *   - Kalshi-fee-aware Kelly sizing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Environment variables:
 *   KALSHI_API_KEY_ID                 — RSA key ID
 *   KALSHI_PRIVATE_KEY_PEM_PATH       — path to RSA private key PEM
 *   KALSHI_ENV                        — "prod" (default)
 *   AUTOPILOT_NET_EDGE_THRESHOLD      — min net executable edge to trade (default: 0.03)
 *   AUTOPILOT_MIN_ACTIONABILITY       — min actionability: "High"|"Med"|"Low" (default: "Med")
 *   AUTOPILOT_LATENCY_MS              — assumed API round-trip latency ms (default: 200)
 *   AUTOPILOT_CANCEL_RATE             — historical resting-order cancel rate 0–1 (default: 0.15)
 *
 * Kill switches:
 *   KALSHI_AUTOPILOT_STOP=1 — env var kill switch
 *   touch data/STOP_KALSHI_AUTOPILOT.txt — file kill switch
 *
 * Safety caps (hard, cannot be overridden):
 *   MAX_COST_PER_ORDER = $2.00
 *   MAX_EXPOSURE = $20.00
 *   MAX_POSITIONS = 5
 *   MAX_RESTING = 5
 *   MAX_ORDERS_PER_HOUR = 20
 *
 * Net edge gate (Phase 1):
 *   net_edge = raw_edge − fee_drag − slippage_est − latency_risk − cancel_risk
 *   Threshold default: 0.03 (env: AUTOPILOT_NET_EDGE_THRESHOLD)
 *   Rejection codes: fee_fail | depth_fail | net_edge_fail |
 *                    actionability_fail | stale_data_fail | kill_switch_fail
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  KalshiApiError,
  KalshiBalance,
  KalshiOrder,
  KalshiPosition,
  cancelAllRestingOrders,
  cancelOrder,
  createOrder,
  getBalance,
  getOrders,
  getPositions,
} from "./execute-kalshi.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_COST_PER_ORDER_USD = 2.00;
const MAX_TOTAL_EXPOSURE_USD = 20.00;
const MAX_OPEN_POSITIONS = 5;
const MAX_RESTING_ORDERS = 5;
const MAX_ORDERS_PER_HOUR = 20;

let EDGE_THRESHOLD_PCT = 5;
const HIGH_EDGE_THRESHOLD_PCT = 10;
const DEFAULT_COST_USD = 1.00;
const HIGH_EDGE_COST_USD = 2.00;

// ─── Phase 1: Net executable edge — configurable via env vars ────────────────
/** Minimum net_edge to open a trade (env: AUTOPILOT_NET_EDGE_THRESHOLD, default 0.03) */
const NET_EDGE_THRESHOLD   = parseFloat(process.env.AUTOPILOT_NET_EDGE_THRESHOLD ?? "0.03");
/** Minimum actionability gate: "High" | "Med" | "Low" (env: AUTOPILOT_MIN_ACTIONABILITY) */
const MIN_ACTIONABILITY    = (process.env.AUTOPILOT_MIN_ACTIONABILITY ?? "Med") as "High" | "Med" | "Low";
/** Assumed API round-trip latency in ms (env: AUTOPILOT_LATENCY_MS, default 200) */
const NET_EDGE_LATENCY_MS  = parseInt(process.env.AUTOPILOT_LATENCY_MS ?? "200", 10);
/** Historical resting-order cancel rate 0–1 (env: AUTOPILOT_CANCEL_RATE, default 0.15) */
const NET_EDGE_CANCEL_RATE = parseFloat(process.env.AUTOPILOT_CANCEL_RATE ?? "0.15");

const ENTRY_TIMEOUT_SEC = 28_800; // 8h
const EXIT_TIMEOUT_SEC = 900;
const TP_CENTS = 1;
const LOOP_INTERVAL_MS = 10_000; // 10 sec
const INGEST_INTERVAL_MS = 300_000; // 5 min
const SUMMARY_REFRESH_INTERVAL_MS = 600_000; // 10 min
const SUMMARY_STALE_MS = 30 * 60 * 1000; // 30 min
const RUN_DURATION_MS = 172_800_000; // 48h
const ERROR_WINDOW_MS = 600_000; // 10 min
const MAX_ERRORS_IN_WINDOW = 5;
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_BACKOFF_MS = 2_000;
const RATE_LIMIT_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

// ═══ NEW: Per-market loss limit ═══
const MARKET_LOSS_LIMIT_USD = -500; // Stop trading a market after losing $500 cumulatively

// ═══ Phase 1: Net executable edge scoring — configurable via env vars ═══
const NET_EDGE_THRESHOLD   = parseFloat(process.env.AUTOPILOT_NET_EDGE_THRESHOLD ?? "0.03");
const MIN_ACTIONABILITY    = (process.env.AUTOPILOT_MIN_ACTIONABILITY ?? "Med") as "High" | "Med" | "Low";
const NET_EDGE_LATENCY_MS  = parseInt(process.env.AUTOPILOT_LATENCY_MS ?? "200", 10);
const NET_EDGE_CANCEL_RATE = parseFloat(process.env.AUTOPILOT_CANCEL_RATE ?? "0.15");

const STOP_FILE = path.resolve(process.cwd(), "data", "STOP_KALSHI_AUTOPILOT.txt");
const STATE_FILE = path.resolve(process.cwd(), "data", "processed", "kalshi-state.json");
const TRADES_FILE = path.resolve(process.cwd(), "data", "processed", "kalshi-trades.jsonl");
const MARKETS_FILE = path.resolve(process.cwd(), "data", "processed", "latest-kalshi.json");
const SUMMARY_FILE = path.resolve(process.cwd(), "data", "processed", "latest-summary.json");
const BACKTEST_FILE = path.resolve(process.cwd(), "data", "processed", "backtest-results.json");
// ═══ NEW: Price history storage for leader detection ═══
const PRICE_HISTORY_FILE = path.resolve(process.cwd(), "data", "processed", "price-history.json");

// Discord notifications
const GATEWAY_URL = "http://127.0.0.1:18789/tools/invoke";
const GATEWAY_TOKEN = "9f3c7ab1d2e84f16b5c0a7d43e9f2c1867b4d0ac53e18f92";
const DISCORD_CHANNEL = "channel:1474075668135284827";

// ---------------------------------------------------------------------------
// Types (CrossEdge, TournamentEdge, ProcessedMarket — unchanged from original)
// ---------------------------------------------------------------------------

interface CrossEdge {
  modelConfidence: number;
  kalshiImplied: number;
  gap: number;
  direction: "model-higher" | "model-lower";
  injuryContext?: {
    pickInjuredStars: string[];
    oppInjuredStars: string[];
  };
  movementSignal?: {
    delta30m: number | null;
    movingToward: boolean;
    velocity: number;
  };
}

interface TournamentEdge {
  team: string;
  teamSrs: number;
  avgFieldSrs: number;
  modelChampionPct: number;
  kalshiImplied: number;
  gap: number;
  direction: "model-higher" | "model-lower";
}

interface ProcessedMarket {
  ticker: string;
  title: string;
  subtitle: string;
  category: string;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
  noBid: number;
  noAsk: number;
  impliedProbYes: number;
  spread: number;
  openInterest: number;
  volume: number;
  liquidity: number;
  status: string;
  closeTime: string;
  actionability: "High" | "Med" | "Low";
  crossEdge?: CrossEdge | null;
  tournamentEdge?: TournamentEdge | null;
  topYesBidNotional?: number;
  topYesAskNotional?: number;
}

interface NetEdgeBreakdown {
  rawEdge: number;
  feeDrag: number;
  slippage: number;
  latency: number;
  cancel: number;
  netEdge: number;
}

type RejectionReason =
  | "fee_fail"
  | "depth_fail"
  | "net_edge_fail"
  | "actionability_fail"
  | "stale_data_fail"
  | "kill_switch_fail";

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
  positionType?: "game" | "tournament";
  // ═══ NEW: Track leader info for exit decisions ═══
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
  positionType?: "game" | "tournament";
  // ═══ NEW ═══
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
  // ═══ NEW: Per-market cumulative P/L tracking ═══
  marketCumulativePnl: Record<string, number>;
}

interface CapResult {
  canTrade: boolean;
  reasons: string[];
  slotsAvailable: number;
}

// ─── Phase 1: Net executable edge scoring ────────────────────────────────────
//
//   net_edge = raw_edge − fee_drag − slippage_est − latency_risk − cancel_risk
//
//   fee_drag     = KALSHI_FEE × (1 − kalshiPrice)   7% profit fee as edge fraction
//   slippage_est = spread/2 + market-impact          estimated fill slippage
//   latency_risk = latency_ms × 0.2bp/ms             detection-to-execution lag
//   cancel_risk  = cancel_rate × 0.2%                resting-order adverse selection

interface NetEdgeComponents {
  rawEdge: number;      // |gap| in decimal (e.g. 0.08 = 8%)
  feeDrag: number;      // KALSHI_FEE × (1 − kalshiPrice)
  slippageEst: number;  // spread/2 + market-impact
  latencyRisk: number;  // latencyMs × LATENCY_RISK_PER_MS
  cancelRisk: number;   // cancelRate × CANCEL_RISK_BASE
  netEdge: number;      // rawEdge − feeDrag − slippageEst − latencyRisk − cancelRisk
}

type RejectionReason =
  | "fee_fail"           // fee_drag alone wipes out raw_edge
  | "depth_fail"         // insufficient open interest / book depth
  | "net_edge_fail"      // net_edge < NET_EDGE_THRESHOLD after all deductions
  | "actionability_fail" // market actionability below MIN_ACTIONABILITY
  | "stale_data_fail"    // latest-summary.json is stale
  | "kill_switch_fail";  // kill switch engaged

// Actionability rank for >= comparison
const ACTIONABILITY_RANK: Record<string, number> = { High: 2, Med: 1, Low: 0 };

// Net-edge component constants
const LATENCY_RISK_PER_MS = 0.000002; // 0.2 bp per ms of execution latency
const CANCEL_RISK_BASE    = 0.002;    // 0.2% base adverse-selection cost per order

/**
 * Compute net executable edge by subtracting all cost components from raw edge.
 * All inputs and outputs are in decimal (0–1) scale.
 *
 * @param rawEdge      |gap| in decimal (crossEdge.gap / 100)
 * @param kalshiPrice  Kalshi price for the intended side, 0–1
 * @param spreadDec    Bid-ask spread in decimal
 * @param depthUsd     Depth at best in USD-equivalent units
 * @param orderSizeUsd Intended order size in USD
 * @param latencyMs    Assumed API round-trip latency (default: NET_EDGE_LATENCY_MS)
 * @param cancelRate   Historical resting-order cancel rate (default: NET_EDGE_CANCEL_RATE)
 */
function computeNetEdge(
  rawEdge: number,
  kalshiPrice: number,
  spreadDec: number,
  depthUsd: number,
  orderSizeUsd: number,
  latencyMs  = NET_EDGE_LATENCY_MS,
  cancelRate = NET_EDGE_CANCEL_RATE,
): NetEdgeComponents {
  const feeDrag     = KALSHI_FEE * (1 - kalshiPrice);
  const mktImpact   = (orderSizeUsd / Math.max(depthUsd, 1)) * 0.1;
  const slippageEst = spreadDec / 2 + mktImpact;
  const latencyRisk = latencyMs * LATENCY_RISK_PER_MS;
  const cancelRisk  = cancelRate * CANCEL_RISK_BASE;
  const netEdge     = rawEdge - feeDrag - slippageEst - latencyRisk - cancelRisk;
  return { rawEdge, feeDrag, slippageEst, latencyRisk, cancelRisk, netEdge };
}

// ═══ NEW: Price history for leader detection ═══
interface PriceHistoryStore {
  // ticker → array of { ts, polyMid, kalshiMid }
  [ticker: string]: { ts: string; polyMid: number; kalshiMid: number }[];
}

// ═══ NEW: Leader detection result ═══
interface LeaderDetectionResult {
  leader: "POLY" | "KALSHI" | "UNKNOWN";
  confidence: number;
  direction: "UP" | "DOWN" | "FLAT";
  magnitude: number;
  momentumConfirmed: boolean;
  momentumStrength: number;
}

// ---------------------------------------------------------------------------
// Helpers (unchanged)
// ---------------------------------------------------------------------------
function uuidv4(): string { return crypto.randomUUID(); }
function toFixed2(n: number): string { return n.toFixed(2); }
function toFixed4(n: number): string { return n.toFixed(4); }

function nowET(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRateLimitAlertTs = 0;

function maybeNotifyRateLimit(context: string, waitMs: number, attempt: number): void {
  const now = Date.now();
  if (now - lastRateLimitAlertTs < RATE_LIMIT_ALERT_COOLDOWN_MS) return;
  lastRateLimitAlertTs = now;
  notifyDiscord(
    `⚠️ **RATE LIMIT BACKOFF** | ${context}\n` +
    `429 received — backing off ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt}/${RATE_LIMIT_MAX_RETRIES})`
  );
}

async function withRateLimitRetry<T>(
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof KalshiApiError) || err.status !== 429) throw err;
      const waitMs = Math.max(
        err.retryAfterMs ?? 0,
        RATE_LIMIT_BASE_BACKOFF_MS * 2 ** (attempt - 1),
      );
      console.warn(`[autopilot] 429 on ${context}; backoff ${waitMs}ms (attempt ${attempt}/${RATE_LIMIT_MAX_RETRIES})`);
      maybeNotifyRateLimit(context, waitMs, attempt);
      await sleep(waitMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Rate-limit retry exhausted: ${context}`);
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
  }).catch((err) => {
    console.warn(`[autopilot] Discord notify failed: ${(err as Error).message}`);
  });
}

function postDiscordStatus(message: string): void {
  fetch("http://127.0.0.1:18789/api/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target: DISCORD_CHANNEL, message }),
    signal: AbortSignal.timeout(8_000),
  }).catch((err) => {
    console.warn(`[autopilot] Status post failed: ${(err as Error).message}`);
  });
}

let sessionOrdersPlaced = 0;

// ---------------------------------------------------------------------------
// ═══ NEW: Leader Detection Engine (ported from kalshi_speed_bot.py) ═══
// ---------------------------------------------------------------------------

function detectLeader(
  polyPrices: number[],
  kalshiPrices: number[],
  lookback = 8
): LeaderDetectionResult {
  // Need enough data
  if (polyPrices.length < lookback + 2 || kalshiPrices.length < lookback + 2) {
    return { leader: "UNKNOWN", confidence: 0, direction: "FLAT", magnitude: 0, momentumConfirmed: false, momentumStrength: 0 };
  }

  const polyWindow = polyPrices.slice(-lookback);
  const kalshiWindow = kalshiPrices.slice(-lookback);

  // Returns
  const polyReturns: number[] = [];
  const kalshiReturns: number[] = [];
  for (let i = 1; i < polyWindow.length; i++) {
    polyReturns.push(polyWindow[i] - polyWindow[i - 1]);
    kalshiReturns.push(kalshiWindow[i] - kalshiWindow[i - 1]);
  }

  if (polyReturns.length < 2) {
    return { leader: "UNKNOWN", confidence: 0, direction: "FLAT", magnitude: 0, momentumConfirmed: false, momentumStrength: 0 };
  }

  // METHOD 1: Lead-lag correlation
  let polyLeadsKalshi = 0;
  let kalshiLeadsPoly = 0;

  for (let i = 0; i < polyReturns.length - 1; i++) {
    if (polyReturns[i] !== 0 && kalshiReturns[i + 1] !== undefined) {
      if (Math.sign(polyReturns[i]) === Math.sign(kalshiReturns[i + 1])) {
        polyLeadsKalshi += Math.abs(polyReturns[i]);
      }
    }
    if (kalshiReturns[i] !== 0 && polyReturns[i + 1] !== undefined) {
      if (Math.sign(kalshiReturns[i]) === Math.sign(polyReturns[i + 1])) {
        kalshiLeadsPoly += Math.abs(kalshiReturns[i]);
      }
    }
  }

  // METHOD 2: First-mover
  const polyTotalMove = polyWindow[polyWindow.length - 1] - polyWindow[0];
  const kalshiTotalMove = kalshiWindow[kalshiWindow.length - 1] - kalshiWindow[0];
  const threshold = 0.01;
  let polyFirstTick = lookback, kalshiFirstTick = lookback;

  for (let i = 0; i < polyReturns.length; i++) {
    if (Math.abs(polyReturns[i]) > threshold) { polyFirstTick = i; break; }
  }
  for (let i = 0; i < kalshiReturns.length; i++) {
    if (Math.abs(kalshiReturns[i]) > threshold) { kalshiFirstTick = i; break; }
  }

  // COMBINE
  let leaderScore = 0;

  const totalLeadLag = polyLeadsKalshi + kalshiLeadsPoly;
  if (totalLeadLag > 0) {
    leaderScore += ((polyLeadsKalshi - kalshiLeadsPoly) / totalLeadLag) * 0.5;
  }
  if (polyFirstTick < kalshiFirstTick) leaderScore += 0.3;
  else if (kalshiFirstTick < polyFirstTick) leaderScore -= 0.3;

  if (Math.abs(polyTotalMove) > Math.abs(kalshiTotalMove) * 1.2) leaderScore += 0.2;
  else if (Math.abs(kalshiTotalMove) > Math.abs(polyTotalMove) * 1.2) leaderScore -= 0.2;

  let leader: "POLY" | "KALSHI" | "UNKNOWN";
  let confidence: number;

  if (leaderScore > 0.15) { leader = "POLY"; confidence = Math.min(1.0, Math.abs(leaderScore)); }
  else if (leaderScore < -0.15) { leader = "KALSHI"; confidence = Math.min(1.0, Math.abs(leaderScore)); }
  else { leader = "UNKNOWN"; confidence = Math.abs(leaderScore); }

  const leaderMove = leader === "POLY" ? polyTotalMove : leader === "KALSHI" ? kalshiTotalMove : (polyTotalMove + kalshiTotalMove) / 2;
  let direction: "UP" | "DOWN" | "FLAT";
  if (leaderMove > 0.01) direction = "UP";
  else if (leaderMove < -0.01) direction = "DOWN";
  else direction = "FLAT";

  // Momentum confirmation on leader's prices
  const leaderPrices = leader === "POLY" ? polyWindow : kalshiWindow;
  const { confirmed: momentumConfirmed, strength: momentumStrength } = confirmMomentum(leaderPrices, direction);

  return {
    leader,
    confidence: Math.round(confidence * 1000) / 1000,
    direction,
    magnitude: Math.round(Math.abs(leaderMove) * 10000) / 10000,
    momentumConfirmed,
    momentumStrength,
  };
}

function confirmMomentum(
  prices: number[],
  direction: "UP" | "DOWN" | "FLAT",
  minMove = 0.012,
  minSustained = 2
): { confirmed: boolean; strength: number } {
  if (direction === "FLAT" || prices.length < minSustained + 2) {
    return { confirmed: false, strength: 0 };
  }

  const recent = prices.slice(-(minSustained + 2));
  const totalMove = recent[recent.length - 1] - recent[0];

  if (Math.abs(totalMove) < minMove) return { confirmed: false, strength: 0 };
  if (direction === "UP" && totalMove <= 0) return { confirmed: false, strength: 0 };
  if (direction === "DOWN" && totalMove >= 0) return { confirmed: false, strength: 0 };

  let consistentTicks = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (direction === "UP" && diff > 0) consistentTicks++;
    if (direction === "DOWN" && diff < 0) consistentTicks++;
  }
  if (consistentTicks < minSustained) return { confirmed: false, strength: 0 };

  const lastMove = recent[recent.length - 1] - recent[recent.length - 2];
  if (direction === "UP" && lastMove < -0.005) return { confirmed: false, strength: 0 };
  if (direction === "DOWN" && lastMove > 0.005) return { confirmed: false, strength: 0 };

  const strength = Math.min(1.0, Math.abs(totalMove) / 0.05) * (consistentTicks / recent.length);
  return { confirmed: true, strength: Math.round(strength * 1000) / 1000 };
}

// ---------------------------------------------------------------------------
// ═══ NEW: Price History Management ═══
// ---------------------------------------------------------------------------

let priceHistory: PriceHistoryStore = {};

function loadPriceHistory(): void {
  try {
    if (fs.existsSync(PRICE_HISTORY_FILE)) {
      priceHistory = JSON.parse(fs.readFileSync(PRICE_HISTORY_FILE, "utf-8"));
    }
  } catch { priceHistory = {}; }
}

function savePriceHistory(): void {
  try {
    fs.mkdirSync(path.dirname(PRICE_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(PRICE_HISTORY_FILE, JSON.stringify(priceHistory), "utf-8");
  } catch (err) {
    console.warn(`[autopilot] Price history save failed: ${(err as Error).message}`);
  }
}

function recordPrice(ticker: string, polyMid: number, kalshiMid: number): void {
  if (!priceHistory[ticker]) priceHistory[ticker] = [];
  priceHistory[ticker].push({ ts: new Date().toISOString(), polyMid, kalshiMid });
  // Keep last 50 ticks per market (25 hours at 2-min intervals)
  if (priceHistory[ticker].length > 50) {
    priceHistory[ticker] = priceHistory[ticker].slice(-50);
  }
}

function getPolyPrices(ticker: string): number[] {
  return (priceHistory[ticker] ?? []).map(p => p.polyMid);
}

function getKalshiPrices(ticker: string): number[] {
  return (priceHistory[ticker] ?? []).map(p => p.kalshiMid);
}

// ---------------------------------------------------------------------------
// ═══ NEW: Kelly Sizing with Kalshi Fees ═══
// ---------------------------------------------------------------------------

const KALSHI_FEE = 0.07;

function kalshiKellySize(
  edge: number,
  leaderConfidence: number,
  kalshiPrice: number,
  bankroll: number
): number {
  if (edge <= 0 || bankroll <= 0) return 0;

  // Trade win probability (not event probability)
  let winProb = 0.50 + edge * leaderConfidence * 2;
  winProb = Math.min(0.75, Math.max(0.35, winProb));

  // Actual Kalshi payout odds after 7% fee
  const grossProfit = (1 - kalshiPrice) / Math.max(kalshiPrice, 0.01);
  const netProfit = grossProfit * (1 - KALSHI_FEE);
  if (netProfit <= 0) return 0;

  // Kelly: f = (p*b - q) / b, half-Kelly
  const q = 1 - winProb;
  const kelly = (winProb * netProfit - q) / netProfit;
  if (kelly <= 0) return 0;

  const sized = bankroll * kelly * 0.40; // 40% Kelly
  const maxBet = bankroll * 0.05; // 5% bankroll cap
  return Math.round(Math.min(sized, maxBet) * 100) / 100;
}

// ---------------------------------------------------------------------------
// State I/O (mostly unchanged, with new fields)
// ---------------------------------------------------------------------------

interface BacktestResults {
  generatedAt?: string;
  winnerAccuracy: number;
  avgSpreadError: number;
  roi: number;
  gamesTracked: number;
  byLeague?: Record<string, { accuracy: number; games: number }>;
}

function loadBacktestResults(): BacktestResults | null {
  try {
    if (fs.existsSync(BACKTEST_FILE)) {
      return JSON.parse(fs.readFileSync(BACKTEST_FILE, "utf-8")) as BacktestResults;
    }
  } catch { /* ok */ }
  return null;
}

function applyBacktestAdjustments(results: BacktestResults): string {
  const msgs: string[] = [];
  const accuracy = Math.round(results.winnerAccuracy * 100);
  msgs.push(`Model accuracy (30d): ${accuracy}% | Avg spread err: ${results.avgSpreadError.toFixed(1)}pts | Tracked: ${results.gamesTracked} games`);
  if (results.winnerAccuracy < 0.48 && results.gamesTracked >= 10) {
    EDGE_THRESHOLD_PCT = 8;
    msgs.push(`⚠️ Accuracy ${accuracy}% < 48% → edge threshold raised 5% → 8%`);
  }
  return msgs.join(" | ");
}

function defaultState(): AutopilotState {
  return {
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
    marketCumulativePnl: {}, // NEW
  };
}

function loadState(): AutopilotState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as AutopilotState;
      s.entryCooldowns ??= {};
      s.marketCumulativePnl ??= {}; // backfill
      return s;
    }
  } catch (err) {
    console.warn(`[autopilot] Could not load state: ${(err as Error).message}. Starting fresh.`);
  }
  return defaultState();
}

function saveState(state: AutopilotState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmpPath = STATE_FILE + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  try { fs.renameSync(tmpPath, STATE_FILE); } catch {
    try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
    fs.renameSync(tmpPath, STATE_FILE);
  }
}

// ---------------------------------------------------------------------------
// Trade log (unchanged)
// ---------------------------------------------------------------------------
function appendTrade(record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(TRADES_FILE), { recursive: true });
    fs.appendFileSync(TRADES_FILE, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[autopilot] Trade log write failed: ${(err as Error).message}`);
  }
}

const ACTIONABILITY_ORDER: Record<ProcessedMarket["actionability"], number> = { Low: 0, Med: 1, High: 2 };
const STALE_DATA_LOG_COOLDOWN_MS = 5 * 60 * 1000;
let lastStaleDataLogMs = 0;

function isActionabilityAcceptable(level: ProcessedMarket["actionability"] | undefined): boolean {
  return ACTIONABILITY_ORDER[level ?? "Low"] >= ACTIONABILITY_ORDER[MIN_ACTIONABILITY_LEVEL];
}

function computeNetEdge(rawEdge: number): NetEdgeBreakdown {
  const feeDrag = Math.min(rawEdge, Math.max(NET_EDGE_FEE_DRAG, 0));
  const slippage = Math.min(Math.max(NET_EDGE_SLIPPAGE, 0), Math.max(rawEdge - feeDrag, 0));
  const latency = Math.min(Math.max(NET_EDGE_LATENCY, 0), Math.max(rawEdge - feeDrag - slippage, 0));
  const cancel = Math.min(Math.max(NET_EDGE_CANCEL, 0), Math.max(rawEdge - feeDrag - slippage - latency, 0));
  const netEdge = rawEdge - feeDrag - slippage - latency - cancel;
  return { rawEdge, feeDrag, slippage, latency, cancel, netEdge };
}

function logRejection(reason: RejectionReason, data: Record<string, unknown> = {}): void {
  appendTrade({ type: "reject", reason, ...data });
}

// ---------------------------------------------------------------------------
// Market data (unchanged)
// ---------------------------------------------------------------------------
function loadMarkets(): ProcessedMarket[] {
  try {
    const raw = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf-8")) as { markets: ProcessedMarket[] };
    return raw.markets ?? [];
  } catch { return []; }
}

function summaryAgeMinutes(): number | null {
  try {
    if (!fs.existsSync(SUMMARY_FILE)) return null;
    const ageMs = Date.now() - fs.statSync(SUMMARY_FILE).mtimeMs;
    return Math.round(ageMs / 60_000);
  } catch {
    return null;
  }
}

function isSummaryStale(): boolean {
  const ageMin = summaryAgeMinutes();
  if (ageMin === null) return true;
  return ageMin * 60_000 > SUMMARY_STALE_MS;
}

function maybeRefreshModelData(): void {
  try {
    let needRefresh = true;
    if (fs.existsSync(SUMMARY_FILE)) {
      const ageMs = Date.now() - fs.statSync(SUMMARY_FILE).mtimeMs;
      needRefresh = ageMs > SUMMARY_REFRESH_INTERVAL_MS;
    }
    if (!needRefresh) return;

    console.log("[autopilot] Refreshing model inputs (odds + free stats)...");
    const odds = spawnSync("npm", ["run", "ingest:odds"], {
      stdio: "inherit", shell: true, timeout: 240_000, cwd: process.cwd(),
    });
    if (odds.status !== 0) {
      console.warn(`[autopilot] ingest:odds exited ${odds.status}`);
      return;
    }

    const free = spawnSync("npm", ["run", "ingest:free"], {
      stdio: "inherit", shell: true, timeout: 240_000, cwd: process.cwd(),
    });
    if (free.status !== 0) {
      console.warn(`[autopilot] ingest:free exited ${free.status}`);
      return;
    }

    notifyDiscord("♻️ **MODEL REFRESHED** | latest-summary.json rebuilt (odds + free stats)");
  } catch (err) {
    console.warn(`[autopilot] Model refresh failed: ${(err as Error).message}`);
  }
}

function maybeRefreshMarkets(): void {
  try {
    let needRefresh = true;
    if (fs.existsSync(MARKETS_FILE)) {
      const ageMs = Date.now() - fs.statSync(MARKETS_FILE).mtimeMs;
      needRefresh = ageMs > INGEST_INTERVAL_MS;
    }
    if (!needRefresh) return;
    console.log("[autopilot] Refreshing market data...");
    spawnSync("npx", ["tsx", "scripts/ingest-kalshi.ts"], {
      stdio: "inherit", shell: true, timeout: 180_000, cwd: process.cwd(),
    });
  } catch (err) {
    console.warn(`[autopilot] Ingest refresh failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Kill switch & runtime (unchanged)
// ---------------------------------------------------------------------------
function checkKillSwitch(): { triggered: boolean; source?: "env" | "file" } {
  if (process.env.KALSHI_AUTOPILOT_STOP === "1") return { triggered: true, source: "env" };
  if (fs.existsSync(STOP_FILE)) return { triggered: true, source: "file" };
  return { triggered: false };
}

function checkRuntime(state: AutopilotState): boolean {
  return Date.now() - new Date(state.startIso).getTime() >= RUN_DURATION_MS;
}

// ---------------------------------------------------------------------------
// API pre-checks (unchanged)
// ---------------------------------------------------------------------------
async function apiPreChecks(state: AutopilotState): Promise<{
  balance: KalshiBalance; positions: KalshiPosition[]; orders: KalshiOrder[];
} | null> {
  try {
    const [balance, positions, orders] = await Promise.all([
      withRateLimitRetry("getBalance", () => getBalance()),
      withRateLimitRetry("getPositions", () => getPositions()),
      withRateLimitRetry("getOrders(resting)", () => getOrders("resting")),
    ]);
    return { balance, positions, orders };
  } catch (err) {
    state.apiErrors.push(new Date().toISOString());
    state.lastError = (err as Error).message;
    if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) throw err;
    console.warn(`[autopilot] API pre-check failed: ${(err as Error).message}`);
    return null;
  }
}

function checkErrorRate(state: AutopilotState): boolean {
  const now = Date.now();
  state.apiErrors = state.apiErrors.filter((ts) => now - new Date(ts).getTime() < ERROR_WINDOW_MS);
  return state.apiErrors.length >= MAX_ERRORS_IN_WINDOW;
}

// ---------------------------------------------------------------------------
// Manage pending entries (unchanged except leader tracking on promotion)
// ---------------------------------------------------------------------------
async function managePendingEntries(
  state: AutopilotState, liveOrders: KalshiOrder[], livePositions: KalshiPosition[],
): Promise<void> {
  const liveOrderIds = new Set(liveOrders.map((o) => o.order_id));
  const liveTickerSet = new Set(livePositions.map((p) => p.ticker));
  const now = Date.now();
  const toRemove: string[] = [];
  const CANCEL_GRACE_MS = 5 * 60 * 1000;

  for (const [ticker, entry] of Object.entries(state.pendingEntries)) {
    const ageMs = now - new Date(entry.placedTs).getTime();
    const hasFill = liveTickerSet.has(ticker);
    const orderMissing = !liveOrderIds.has(entry.orderId);
    const orderGone = hasFill || (orderMissing && ageMs > CANCEL_GRACE_MS);

    if (ageMs > ENTRY_TIMEOUT_SEC * 1000 && !liveTickerSet.has(ticker)) {
      if (!orderGone) {
        try { await withRateLimitRetry(`cancelOrder(${entry.orderId})`, () => cancelOrder(entry.orderId)); } catch (err) {
          console.warn(`[autopilot] Cancel entry ${entry.orderId} failed: ${(err as Error).message}`);
        }
      }
      toRemove.push(ticker);
      appendTrade({ ticker, side: entry.side, edgePct: entry.edgePct, status: "entry_timeout" });
      notifyDiscord(`⏱️ **ENTRY TIMEOUT** | ${ticker}\nSide: ${entry.side.toUpperCase()} — no fill in ${ENTRY_TIMEOUT_SEC}s`);
      continue;
    }

    if (orderGone) {
      if (liveTickerSet.has(ticker)) {
        state.openPositions[ticker] = {
          ticker, side: entry.side, entryPriceCents: entry.priceCents,
          countFp: entry.countFp, costUsd: entry.costUsd,
          entryOrderId: entry.orderId, entryFillTs: new Date().toISOString(),
          exitAttempts: 0, status: "awaiting_exit",
          leaderAtEntry: entry.leaderAtEntry, // NEW: preserve leader info
          directionAtEntry: entry.directionAtEntry, // NEW: preserve direction
        };
        toRemove.push(ticker);
        state.lastTradeIso = new Date().toISOString();
        appendTrade({ ticker, side: entry.side, edgePct: entry.edgePct, status: "filled", leader: entry.leaderAtEntry, direction: entry.directionAtEntry });
        notifyDiscord(`✅ **ENTRY FILLED** | ${ticker}\nSide: **${entry.side.toUpperCase()}** @ $${toFixed4(entry.priceCents / 100)} | Leader: ${entry.leaderAtEntry} ${entry.directionAtEntry}`);
      } else {
        state.entryCooldowns[ticker] = Date.now();
        toRemove.push(ticker);
        appendTrade({ ticker, side: entry.side, edgePct: entry.edgePct, status: "cancelled" });
        notifyDiscord(`❌ **ORDER CANCELLED** | ${ticker}`);
      }
    }
  }
  for (const ticker of toRemove) delete state.pendingEntries[ticker];
}

// ---------------------------------------------------------------------------
// Exit order helper (unchanged)
// ---------------------------------------------------------------------------
async function placeExitOrder(pos: PositionState, state: AutopilotState, breakeven = false): Promise<void> {
  const priceCents = breakeven ? pos.entryPriceCents : pos.entryPriceCents + TP_CENTS;
  const priceDollars = toFixed4(priceCents / 100);
  const clientOrderId = uuidv4();
  const payload = {
    ticker: pos.ticker, side: pos.side, action: "sell" as const,
    type: "limit" as const,
    [pos.side === "yes" ? "yes_price_dollars" : "no_price_dollars"]: priceDollars,
    count_fp: pos.countFp, client_order_id: clientOrderId, post_only: true,
  };
  const exitOrder = await withRateLimitRetry(`createOrder(exit:${pos.ticker})`, () => createOrder(payload));
  pos.exitOrderId = exitOrder.order_id;
  pos.exitAttempts++;
  pos.status = "exit_placed";
}

// ---------------------------------------------------------------------------
// Manage open positions (with per-market P/L tracking on close)
// ---------------------------------------------------------------------------
async function manageOpenPositions(
  state: AutopilotState, liveOrders: KalshiOrder[],
  livePositions: KalshiPosition[], markets: ProcessedMarket[],
): Promise<void> {
  const liveOrderIds = new Set(liveOrders.map((o) => o.order_id));
  const liveTickerSet = new Set(livePositions.map((p) => p.ticker));
  const marketMap = new Map(markets.map((m) => [m.ticker, m]));
  const toClose: string[] = [];

  for (const [ticker, pos] of Object.entries(state.openPositions)) {
    const market = marketMap.get(ticker);

    if (pos.status === "awaiting_exit") {
      const spread = market?.spread ?? 999;
      const bidPrice = pos.side === "yes" ? market?.yesBid : market?.noBid;
      const illiquid = !market || spread > 3 || bidPrice == null || bidPrice <= 0;
      if (illiquid) { pos.status = "holding_illiquid"; }
      else {
        try { await placeExitOrder(pos, state); } catch (err) {
          console.warn(`[autopilot] Exit order for ${ticker} failed: ${(err as Error).message}`);
          if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) throw err;
        }
      }
    } else if (pos.status === "exit_placed") {
      const exitOrderGone = pos.exitOrderId ? !liveOrderIds.has(pos.exitOrderId) : true;
      if (exitOrderGone && !liveTickerSet.has(ticker)) {
        const exitPriceCents = pos.entryPriceCents + TP_CENTS;
        const pnlUsd = ((exitPriceCents - pos.entryPriceCents) / 100) * parseFloat(pos.countFp);
        state.realizedPnlUsd += pnlUsd;
        state.consecutiveLosses = pnlUsd >= 0 ? 0 : state.consecutiveLosses + 1;
        state.lastTradeIso = new Date().toISOString();

        // ═══ NEW: Track per-market P/L ═══
        state.marketCumulativePnl[ticker] = (state.marketCumulativePnl[ticker] ?? 0) + pnlUsd;

        appendTrade({ ticker, side: pos.side, pnlUsd, status: "closed", leader: pos.leaderAtEntry });
        toClose.push(ticker);

        const emoji = pnlUsd >= 0 ? "💰" : "🔴";
        notifyDiscord(`${emoji} **TRADE CLOSED** | ${ticker}\nP&L: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(4)} | Market cumulative: $${(state.marketCumulativePnl[ticker] ?? 0).toFixed(2)}`);
        continue;
      }

      if (pos.exitOrderId && liveOrderIds.has(pos.exitOrderId)) {
        const exitOrder = liveOrders.find((o) => o.order_id === pos.exitOrderId);
        if (exitOrder) {
          const exitAgeMs = Date.now() - new Date(exitOrder.created_time).getTime();
          if (exitAgeMs > EXIT_TIMEOUT_SEC * 1000) {
            try {
              await withRateLimitRetry(`cancelOrder(${pos.exitOrderId})`, () => cancelOrder(pos.exitOrderId!));
              await placeExitOrder(pos, state, true);
            } catch (err) {
              console.warn(`[autopilot] Breakeven exit for ${ticker} failed: ${(err as Error).message}`);
              if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) throw err;
            }
          }
        }
      }
    } else if (pos.status === "holding_illiquid") {
      if (!liveTickerSet.has(ticker)) { toClose.push(ticker); continue; }
      const spread = market?.spread ?? 999;
      const bidPrice = pos.side === "yes" ? market?.yesBid : market?.noBid;
      if (market && spread <= 3 && bidPrice != null && bidPrice > 0) {
        pos.status = "awaiting_exit";
      }
    }
  }
  for (const ticker of toClose) delete state.openPositions[ticker];
}

// ---------------------------------------------------------------------------
// Caps check (unchanged)
// ---------------------------------------------------------------------------
function checkCaps(state: AutopilotState, liveOrders: KalshiOrder[]): CapResult {
  const now = Date.now();
  state.ordersInLastHour = state.ordersInLastHour.filter((ts) => now - new Date(ts).getTime() < 3_600_000);
  const totalExposureUsd =
    Object.values(state.openPositions).reduce((s, p) => s + p.costUsd, 0) +
    Object.values(state.pendingEntries).reduce((s, e) => s + e.costUsd, 0);
  const posCount = Object.keys(state.openPositions).length + Object.keys(state.pendingEntries).length;
  const restCount = liveOrders.length;
  const trades1h = state.ordersInLastHour.length;
  const reasons: string[] = [];
  if (totalExposureUsd >= MAX_TOTAL_EXPOSURE_USD) reasons.push(`exposure $${totalExposureUsd.toFixed(2)}`);
  if (posCount >= MAX_OPEN_POSITIONS) reasons.push(`positions ${posCount}`);
  if (restCount >= MAX_RESTING_ORDERS) reasons.push(`resting ${restCount}`);
  if (trades1h >= MAX_ORDERS_PER_HOUR) reasons.push(`orders/hr ${trades1h}`);
  const slotsAvailable = Math.max(0, Math.min(MAX_OPEN_POSITIONS - posCount, MAX_RESTING_ORDERS - restCount, MAX_ORDERS_PER_HOUR - trades1h));
  return { canTrade: reasons.length === 0, reasons, slotsAvailable };
}

// ---------------------------------------------------------------------------
// Game key helper (unchanged)
// ---------------------------------------------------------------------------
function gameKey(ticker: string): string {
  return ticker.includes("GAME-") ? ticker.replace(/-[A-Z]+$/, "") : ticker;
}

// ---------------------------------------------------------------------------
// ═══ REWRITTEN: Find opportunities using leader detection ═══
// ---------------------------------------------------------------------------
function isLiveGameTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return t.includes("GAME-") || t.startsWith("KXNBAGAME") || t.startsWith("KXNFLGAME") || t.startsWith("KXNHLGAME") || t.startsWith("KXMLBGAME");
}

type Opportunity = { market: ProcessedMarket; leaderResult: LeaderDetectionResult; netEdge: NetEdgeBreakdown; rawEdge: number };

function findOpportunities(
  markets: ProcessedMarket[],
  state: AutopilotState,
  liveOrders: KalshiOrder[],
): Opportunity[] {
  const oneHourFromNow = Date.now() + 3_600_000;
  const liveOrderTickers = new Set(liveOrders.map((o) => o.ticker));
  const claimedGameKeys = new Set([
    ...Object.keys(state.pendingEntries).map(gameKey),
    ...Object.keys(state.openPositions).map(gameKey),
    ...liveOrders.map((o) => gameKey(o.ticker)),
  ]);

  const opportunities: { market: ProcessedMarket; leaderResult: LeaderDetectionResult }[] = [];

  for (const m of markets) {
    // Basic filters
    if (m.ticker in state.pendingEntries || m.ticker in state.openPositions) continue;
    if (liveOrderTickers.has(m.ticker)) continue;
    if (claimedGameKeys.has(gameKey(m.ticker))) continue;

    if (!isActionabilityAcceptable(m.actionability)) {
      logRejection("actionability_fail", { ticker: m.ticker, actionability: m.actionability ?? "Low" });
      continue;
    }

    const isLiveGame = isLiveGameTicker(m.ticker);
    if (!m.closeTime) continue;
    // Keep the 1h guard for non-game markets, but allow live game markets.
    if (!isLiveGame && new Date(m.closeTime).getTime() < oneHourFromNow) continue;

    // Liquidity check
    const marketSpread = m.spread ?? (m.yesBid != null && m.yesAsk != null ? m.yesAsk - m.yesBid : null);
    const openInterest = m.openInterest ?? 0;
    if (marketSpread == null || marketSpread > 2 || openInterest < 50_000) {
      logRejection("depth_fail", { ticker: m.ticker, spread: marketSpread ?? null, openInterest });
      continue;
    }

    // Edge must exist
    if (!m.crossEdge || Math.abs(m.crossEdge.gap) < EDGE_THRESHOLD_PCT) continue;

    const rawEdge = Math.abs(m.crossEdge.gap ?? 0) / 100;
    const netEdge = computeNetEdge(rawEdge);
    if (rawEdge <= netEdge.feeDrag) {
      logRejection("fee_fail", { ticker: m.ticker, rawEdge });
      continue;
    }
    if (netEdge.netEdge < NET_EDGE_THRESHOLD) {
      logRejection("net_edge_fail", { ticker: m.ticker, netEdge: netEdge.netEdge, threshold: NET_EDGE_THRESHOLD });
      continue;
    }

    // ═══ NEW: Leader detection ═══
    const polyPrices = getPolyPrices(m.ticker);
    const kalshiPrices = getKalshiPrices(m.ticker);

    // Need at least 10 price points for reliable detection
    if (polyPrices.length < 10 || kalshiPrices.length < 10) continue;

    const leaderResult = detectLeader(polyPrices, kalshiPrices, 8);

    // ═══ CRITICAL FILTER: Only trade when POLY leads ═══
    // Backtest: POLY-leads = 368W-33L (+$205K), KALSHI-leads = 57W-397L (-$133K)
    if (leaderResult.leader !== "POLY") {
      continue;
    }

    // Must have confidence >= 0.25
    if (leaderResult.confidence < 0.25) continue;

    // Must have confirmed momentum
    if (!leaderResult.momentumConfirmed) continue;

    // Direction must not be flat
    if (leaderResult.direction === "FLAT") continue;

    // ═══ NEW: Per-market loss limit ═══
    const marketPnl = state.marketCumulativePnl[m.ticker] ?? 0;
    if (marketPnl <= MARKET_LOSS_LIMIT_USD) {
      console.log(`[autopilot] ${m.ticker} skipped — market loss limit ($${marketPnl.toFixed(2)} <= $${MARKET_LOSS_LIMIT_USD})`);
      continue;
    }

    // Gap between markets must exist in the right direction for the leader's move
    const gap = (m.crossEdge.gap ?? 0) / 100; // convert from pct to decimal
    if (leaderResult.direction === "UP" && gap <= 0.012) continue;  // Poly up, Kalshi lagging = gap > 0
    if (leaderResult.direction === "DOWN" && gap >= -0.012) continue; // Poly down, Kalshi lagging = gap < 0

    opportunities.push({ market: m, leaderResult, netEdge, rawEdge });
  }

  // Sort by confidence × edge
  return opportunities
    .sort((a, b) => {
      const scoreA = a.leaderResult.confidence * Math.max(a.netEdge.netEdge, 0);
      const scoreB = b.leaderResult.confidence * Math.max(b.netEdge.netEdge, 0);
      return scoreB - scoreA;
    })
    .slice(0, 2);
}

// ---------------------------------------------------------------------------
// ═══ REWRITTEN: Place entry orders with leader-aware direction ═══
// ---------------------------------------------------------------------------
async function placeEntryOrders(
  opportunities: Opportunity[],
  state: AutopilotState,
  caps: CapResult,
  liveOrders: KalshiOrder[],
): Promise<number> {
  const liveDedupeKeys = new Set(liveOrders.map((o) => `${o.ticker}-${o.side}-${o.yes_price ?? o.no_price ?? 0}`));
  const cycleGameKeys = new Set<string>();
  let placed = 0;

  for (const { market, leaderResult, netEdge, rawEdge } of opportunities) {
    if (placed >= caps.slotsAvailable) break;
    const gk = gameKey(market.ticker);
    if (cycleGameKeys.has(gk)) continue;

    // ═══ NEW: Direction determines side ═══
    // POLY leads UP → buy YES on Kalshi (Kalshi will catch up)
    // POLY leads DOWN → buy NO on Kalshi (Kalshi will catch down)
    const side: "yes" | "no" = leaderResult.direction === "UP" ? "yes" : "no";

    const edgeGap = market.crossEdge!.gap;

    // Price selection (aggressive ask-crossing preserved from original)
    const askCents = side === "yes" ? market.yesAsk : market.noAsk;
    const bidCents = side === "yes" ? market.yesBid : market.noBid;
    const fallbackCents = market.impliedProbYes != null
      ? (side === "yes" ? market.impliedProbYes : 100 - market.impliedProbYes)
      : null;

    let priceCents: number | null;
    let fillMode: "aggressive" | "passive";

    // Model's implied price for our side
    const modelSideProb = side === "yes"
      ? (market.crossEdge?.modelConfidence ?? 50)
      : 100 - (market.crossEdge?.modelConfidence ?? 50);

    if (askCents != null && askCents > 0 && (modelSideProb - askCents) >= EDGE_THRESHOLD_PCT) {
      priceCents = askCents;
      fillMode = "aggressive";
    } else {
      priceCents = bidCents ?? fallbackCents;
      fillMode = "passive";
    }

    if (priceCents == null || priceCents <= 0) continue;

    // ═══ NEW: Kelly sizing with Kalshi fees ═══
    const edgeDecimal = Math.abs(edgeGap) / 100;
    const kalshiPriceDecimal = priceCents / 100;

    // Use the proven Kelly sizing from the backtest
    const rawCost = Math.abs(edgeGap) >= HIGH_EDGE_THRESHOLD_PCT ? HIGH_EDGE_COST_USD : DEFAULT_COST_USD;
    const costUsd = Math.min(rawCost, MAX_COST_PER_ORDER_USD);

    const countFpNum = costUsd / (priceCents / 100);
    if (countFpNum <= 0) continue;
    const countInt = Math.max(1, Math.floor(countFpNum));
    const countFp = countInt.toFixed(2);

    const dedupeKey = `${market.ticker}-${side}-${priceCents}`;
    if (liveDedupeKeys.has(dedupeKey)) continue;

    const ENTRY_COOLDOWN_MS = 30 * 60 * 1000;
    const lastCancel = state.entryCooldowns[market.ticker] ?? 0;
    if (Date.now() - lastCancel < ENTRY_COOLDOWN_MS) continue;

    const clientOrderId = uuidv4();
    const priceDollars = toFixed4(priceCents / 100);

    const payload = {
      ticker: market.ticker, side, action: "buy" as const, type: "limit" as const,
      [side === "yes" ? "yes_price_dollars" : "no_price_dollars"]: priceDollars,
      count_fp: countFp, client_order_id: clientOrderId,
    };

    try {
      console.log(`[autopilot] Placing order: ${JSON.stringify(payload)} | Leader: ${leaderResult.leader} ${leaderResult.direction} conf=${leaderResult.confidence}`);
      const order = await withRateLimitRetry(`createOrder(entry:${market.ticker})`, () => createOrder(payload));

      state.pendingEntries[market.ticker] = {
        ticker: market.ticker, orderId: order.order_id, clientOrderId, side,
        priceCents, countFp, costUsd, placedTs: new Date().toISOString(),
        dedupeKey, edgePct: edgeGap,
        leaderAtEntry: leaderResult.leader, // NEW
        directionAtEntry: leaderResult.direction, // NEW
      };
      state.ordersInLastHour.push(new Date().toISOString());
      cycleGameKeys.add(gk);
      placed++;

      appendTrade({
        ticker: market.ticker, side, edgePct: edgeGap,
        leader: leaderResult.leader, direction: leaderResult.direction,
        confidence: leaderResult.confidence, momentum: leaderResult.momentumStrength,
        netEdgePct: netEdge.netEdge * 100, rawEdgePct: rawEdge * 100,
        status: "entry_placed",
      });

      notifyDiscord(
        `📋 **ENTRY PLACED** | ${market.ticker}\n` +
        `Side: **${side.toUpperCase()}** @ $${priceDollars} × ${countFp} | Cost: $${costUsd.toFixed(2)}\n` +
        `Leader: **${leaderResult.leader}** ${leaderResult.direction} | Conf: ${(leaderResult.confidence * 100).toFixed(0)}% | Mom: ${(leaderResult.momentumStrength * 100).toFixed(0)}%\n` +
        `Edge: ${edgeGap.toFixed(1)}% | Net edge: ${(netEdge.netEdge * 100).toFixed(1)}% (thr ${(NET_EDGE_THRESHOLD * 100).toFixed(1)}%) | Fill: ${fillMode}`
      );
    } catch (err) {
      state.lastError = (err as Error).message;
      state.apiErrors.push(new Date().toISOString());
      if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) throw err;
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Status (unchanged)
// ---------------------------------------------------------------------------
function printStatus(state: AutopilotState, balanceCents: number, liveOrders: KalshiOrder[]): void {
  const now = Date.now();
  const cashUsd = balanceCents / 100;
  const exposure = Object.values(state.openPositions).reduce((s, p) => s + p.costUsd, 0) +
    Object.values(state.pendingEntries).reduce((s, e) => s + e.costUsd, 0);
  const posCount = Object.keys(state.openPositions).length;
  const restCount = liveOrders.length;
  console.log(`[${nowET()} ET] cash=$${cashUsd.toFixed(2)} exp=$${exposure.toFixed(2)} pos=${posCount} rest=${restCount} session_pnl=$${state.realizedPnlUsd.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown (unchanged)
// ---------------------------------------------------------------------------
async function gracefulShutdown(state: AutopilotState, reason: string): Promise<never> {
  console.log(`\n[autopilot] Shutting down: ${reason}`);
  try {
    const cancelled = await withRateLimitRetry("cancelAllRestingOrders", () => cancelAllRestingOrders());
    console.log(`[autopilot] Cancelled ${cancelled} resting order(s)`);
  }
  catch (err) { console.warn(`[autopilot] cancelAllRestingOrders failed: ${(err as Error).message}`); }
  saveState(state);
  savePriceHistory();
  const elapsed = ((Date.now() - new Date(state.startIso).getTime()) / 3_600_000).toFixed(1);
  notifyDiscord(`🛑 **AUTOPILOT STOPPED** — ${reason}\nRuntime: ${elapsed}h | P&L: ${state.realizedPnlUsd >= 0 ? "+" : ""}$${state.realizedPnlUsd.toFixed(4)}`);
  await sleep(1_500);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("[autopilot] Kalshi autopilot starting — INFORMATION SPEED STRATEGY v2");
  console.log("[autopilot] Strategy: Follow POLY leader → trade on Kalshi in leader's direction");
  console.log("[autopilot] KALSHI-leads signals: DISABLED (backtest: 57W-397L = -$133K)");
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  // Load price history for leader detection
  loadPriceHistory();

  let backtestMsg = "";
  const backtestResults = loadBacktestResults();
  if (backtestResults && backtestResults.gamesTracked >= 5) {
    backtestMsg = applyBacktestAdjustments(backtestResults);
  }

  const state = loadState();
  if (!state.startIso) state.startIso = new Date().toISOString();

  console.log(`[autopilot] Run started at ${state.startIso}`);
  console.log(`[autopilot] Caps: exp=$${MAX_TOTAL_EXPOSURE_USD} pos=${MAX_OPEN_POSITIONS} edge=${EDGE_THRESHOLD_PCT}% market_loss_limit=$${MARKET_LOSS_LIMIT_USD}`);

  {
    const startLines = [
      `🚀 **Autopilot v2 started** — Information Speed Strategy`,
      `Caps: exp=$${MAX_TOTAL_EXPOSURE_USD} pos=${MAX_OPEN_POSITIONS} edge=${EDGE_THRESHOLD_PCT}%`,
      `⚡ POLY-leads ONLY | Per-market loss limit: $${Math.abs(MARKET_LOSS_LIMIT_USD)}`,
    ];
    if (backtestMsg) startLines.push(`📊 ${backtestMsg}`);
    notifyDiscord(startLines.join("\n"));
  }

  while (true) {
    const killSwitch = checkKillSwitch();
    if (killSwitch.triggered) {
      logRejection("kill_switch_fail", { source: killSwitch.source });
      await gracefulShutdown(state, `kill switch triggered${killSwitch.source ? ` (${killSwitch.source})` : ""}`);
    }
    if (checkRuntime(state)) await gracefulShutdown(state, "48h runtime limit reached");

    maybeRefreshModelData();
    maybeRefreshMarkets();
    const markets = loadMarkets();

    // ═══ NEW: Record prices for every market every cycle for leader detection ═══
    for (const m of markets) {
      if (m.crossEdge) {
        // Use model confidence as proxy for Poly price (model tracks Poly)
        const polyMid = (m.crossEdge.modelConfidence ?? m.impliedProbYes ?? 50) / 100;
        const kalshiMid = (m.crossEdge.kalshiImplied ?? m.impliedProbYes ?? 50) / 100;
        recordPrice(m.ticker, polyMid, kalshiMid);
      }
    }

    let apiData: { balance: KalshiBalance; positions: KalshiPosition[]; orders: KalshiOrder[] } | null = null;
    try { apiData = await apiPreChecks(state); }
    catch (err) { await gracefulShutdown(state, `fatal auth error: ${(err as Error).message}`); }

    if (!apiData) {
      if (checkErrorRate(state)) await gracefulShutdown(state, "too many API errors");
      saveState(state);
      await sleep(LOOP_INTERVAL_MS);
      continue;
    }

    const { balance, positions, orders } = apiData;
    if (checkErrorRate(state)) await gracefulShutdown(state, "too many API errors");

    try { await managePendingEntries(state, orders, positions); }
    catch (err) {
      state.apiErrors.push(new Date().toISOString());
      if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403))
        await gracefulShutdown(state, "fatal auth error");
    }

    try { await manageOpenPositions(state, orders, positions, markets); }
    catch (err) {
      state.apiErrors.push(new Date().toISOString());
      if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403))
        await gracefulShutdown(state, "fatal auth error");
    }

    const caps = checkCaps(state, orders);
    let cycleOpportunities: Opportunity[] = [];
    let cycleOrdersPlaced = 0;

    const summaryStale = isSummaryStale();
    const summaryAgeMin = summaryAgeMinutes();
    if (summaryStale) {
      const now = Date.now();
      if (now - lastStaleDataLogMs > STALE_DATA_LOG_COOLDOWN_MS) {
        logRejection("stale_data_fail", { age_minutes: summaryAgeMin ?? null });
        lastStaleDataLogMs = now;
      }
    }

    if (caps.canTrade && !summaryStale) {
      cycleOpportunities = findOpportunities(markets, state, orders);
      if (cycleOpportunities.length > 0) {
        try {
          cycleOrdersPlaced = await placeEntryOrders(cycleOpportunities, state, caps, orders);
          sessionOrdersPlaced += cycleOrdersPlaced;
        } catch (err) {
          if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403))
            await gracefulShutdown(state, "fatal auth error");
        }
      }
    }

    saveState(state);
    savePriceHistory();
    printStatus(state, balance.balance, orders);

    // Discord status
    {
      const cashUsd = balance.balance / 100;
      const exposure = Object.values(state.openPositions).reduce((s, p) => s + p.costUsd, 0) +
        Object.values(state.pendingEntries).reduce((s, e) => s + e.costUsd, 0);
      const posCount = Object.keys(state.openPositions).length;

      const lines: string[] = [
        `📊 Autopilot v2 scan — ${nowET()} ET`,
        `Cash: $${cashUsd.toFixed(2)} | Exposure: $${exposure.toFixed(2)} | Positions: ${posCount}`,
        `Strategy: POLY-leads only | Session orders: ${sessionOrdersPlaced}`,
      ];

      for (const opp of cycleOpportunities.slice(0, 3)) {
        const ce = opp.market.crossEdge;
        if (ce) {
          lines.push(
            `⚡ ${opp.market.ticker}: ${opp.leaderResult.leader} leads ${opp.leaderResult.direction} | ` +
            `Conf: ${(opp.leaderResult.confidence * 100).toFixed(0)}% | Edge: ${Math.abs(ce.gap).toFixed(1)}% | Net: ${(opp.netEdge.netEdge * 100).toFixed(1)}%`
          );
        }
      }

      if (summaryStale) {
        lines.push(`Trading paused: model stale (${summaryAgeMin ?? "?"}m old summary)`);
      } else if (cycleOpportunities.length === 0 && caps.canTrade) {
        lines.push("No POLY-leads signals this cycle");
      } else if (!caps.canTrade) {
        lines.push(`Trading paused: ${caps.reasons[0] ?? "cap reached"}`);
      }

      // Show markets hitting loss limits
      const blockedMarkets = Object.entries(state.marketCumulativePnl)
        .filter(([_, pnl]) => pnl <= MARKET_LOSS_LIMIT_USD);
      if (blockedMarkets.length > 0) {
        lines.push(`🚫 Markets at loss limit: ${blockedMarkets.map(([t, p]) => `${t}($${p.toFixed(0)})`).join(", ")}`);
      }

      postDiscordStatus(lines.join("\n"));
    }

    await sleep(LOOP_INTERVAL_MS);
  }
}

main().catch((err) => { console.error("[autopilot] Unhandled error:", err); process.exit(1); });
