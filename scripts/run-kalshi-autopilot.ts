/**
 * run-kalshi-autopilot.ts — 48h Kalshi autopilot trading runner
 *
 * Environment variables:
 *   KALSHI_API_KEY_ID           — RSA key ID
 *   KALSHI_PRIVATE_KEY_PEM_PATH — path to RSA private key PEM
 *   KALSHI_ENV                  — "prod" (default)
 *
 * Kill switches (checked every cycle):
 *   KALSHI_AUTOPILOT_STOP=1              — env var kill switch
 *   touch data/STOP_KALSHI_AUTOPILOT.txt — file kill switch
 *
 * Safety caps:
 *   MAX_COST_PER_ORDER   = $2.00
 *   MAX_EXPOSURE         = $20.00
 *   MAX_POSITIONS        = 5
 *   MAX_RESTING          = 5
 *   MAX_ORDERS_PER_HOUR  = 20
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

const MAX_COST_PER_ORDER_USD  = 2.00;
const MAX_TOTAL_EXPOSURE_USD  = 20.00;
const MAX_OPEN_POSITIONS      = 5;
const MAX_RESTING_ORDERS      = 5;
const MAX_ORDERS_PER_HOUR     = 20;
let   EDGE_THRESHOLD_PCT      = 5;   // may be raised to 8 by backtest
const HIGH_EDGE_THRESHOLD_PCT = 10;
const DEFAULT_COST_USD        = 1.00;
const HIGH_EDGE_COST_USD      = 2.00;
const ENTRY_TIMEOUT_SEC       = 28_800; // 8h — game winner markets rest until tipoff
const EXIT_TIMEOUT_SEC        = 900;
const TP_CENTS                = 1;
const LOOP_INTERVAL_MS        = 120_000;   // 2 min
const INGEST_INTERVAL_MS      = 300_000;   // 5 min
const RUN_DURATION_MS         = 172_800_000; // 48h
const ERROR_WINDOW_MS         = 600_000;   // 10 min
const MAX_ERRORS_IN_WINDOW    = 5;

const STOP_FILE      = path.resolve(process.cwd(), "data", "STOP_KALSHI_AUTOPILOT.txt");
const STATE_FILE     = path.resolve(process.cwd(), "data", "processed", "kalshi-state.json");
const TRADES_FILE    = path.resolve(process.cwd(), "data", "processed", "kalshi-trades.jsonl");
const MARKETS_FILE   = path.resolve(process.cwd(), "data", "processed", "latest-kalshi.json");
const BACKTEST_FILE  = path.resolve(process.cwd(), "data", "processed", "backtest-results.json");

// Discord notifications via OpenClaw gateway
const GATEWAY_URL     = "http://127.0.0.1:18789/tools/invoke";
const GATEWAY_TOKEN   = "9f3c7ab1d2e84f16b5c0a7d43e9f2c1867b4d0ac53e18f92";
const DISCORD_CHANNEL = "channel:1474075668135284827";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrossEdge {
  modelConfidence: number;   // 0-100
  kalshiImplied: number;     // 0-100
  gap: number;               // modelConfidence - kalshiImplied; positive = model sees YES cheap
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
  yesBid: number;            // cents 0-100
  yesAsk: number;            // cents 0-100
  yesMid: number;
  noBid: number;             // cents 0-100
  noAsk: number;             // cents 0-100
  impliedProbYes: number;
  spread: number;            // cents
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
}

interface AutopilotState {
  startIso: string;
  realizedPnlUsd: number;
  ordersInLastHour: string[];          // ISO timestamps (ring buffer)
  consecutiveLosses: number;
  lastError: string | null;
  lastTradeIso: string | null;
  apiErrors: string[];                 // ISO timestamps of recent API errors
  pendingEntries: Record<string, PendingEntry>;
  openPositions: Record<string, PositionState>;
  entryCooldowns: Record<string, number>; // ticker → unix ms of last external cancel
}

interface CapResult {
  canTrade: boolean;
  reasons: string[];
  slotsAvailable: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuidv4(): string {
  return crypto.randomUUID();
}

function toFixed2(n: number): string {
  return n.toFixed(2);
}

function toFixed4(n: number): string {
  return n.toFixed(4);
}

function nowET(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fire-and-forget Discord notification — never throws, never blocks the loop
function notifyDiscord(message: string): void {
  fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: "message",
      action: "send",
      args: { channel: "discord", target: DISCORD_CHANNEL, message },
      sessionKey: "main",
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch((err) => {
    console.warn(`[autopilot] Discord notify failed: ${(err as Error).message}`);
  });
}

// Per-cycle status summary posted to Discord at the end of each scan loop
function postDiscordStatus(message: string): void {
  fetch("http://127.0.0.1:18789/api/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target: DISCORD_CHANNEL, message }),
    signal: AbortSignal.timeout(8_000),
  }).catch((err) => {
    console.warn(`[autopilot] Status post failed: ${(err as Error).message}`);
  });
}

// Session-wide order counter (persists across loop iterations, resets on restart)
let sessionOrdersPlaced = 0;

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Backtest results
// ---------------------------------------------------------------------------

interface BacktestResults {
  generatedAt?: string;
  winnerAccuracy: number;   // 0-1
  avgSpreadError: number;   // points
  roi: number;              // fraction
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
    console.log(`[autopilot] Backtest accuracy ${accuracy}% — raising EDGE_THRESHOLD_PCT to 8`);
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
  };
}

function loadState(): AutopilotState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as AutopilotState;
      s.entryCooldowns ??= {}; // backfill for states saved before this field existed
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
  try {
    fs.renameSync(tmpPath, STATE_FILE);
  } catch {
    // Windows: destination may exist — unlink first
    try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
    fs.renameSync(tmpPath, STATE_FILE);
  }
}

// ---------------------------------------------------------------------------
// Trade log
// ---------------------------------------------------------------------------

function appendTrade(record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(TRADES_FILE), { recursive: true });
    fs.appendFileSync(
      TRADES_FILE,
      JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + "\n",
      "utf-8",
    );
  } catch (err) {
    console.warn(`[autopilot] Trade log write failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

function loadMarkets(): ProcessedMarket[] {
  try {
    const raw = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf-8")) as {
      markets: ProcessedMarket[];
    };
    return raw.markets ?? [];
  } catch {
    return [];
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
      stdio: "inherit",
      shell: true,       // required on Windows: npx is a .cmd batch file
      timeout: 180_000,  // 3 min — ingest fetches 200 orderbooks
      cwd: process.cwd(),
    });
  } catch (err) {
    console.warn(`[autopilot] Ingest refresh failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Kill switch & runtime
// ---------------------------------------------------------------------------

function checkKillSwitch(): boolean {
  if (process.env.KALSHI_AUTOPILOT_STOP === "1") return true;
  if (fs.existsSync(STOP_FILE)) return true;
  return false;
}

function checkRuntime(state: AutopilotState): boolean {
  return Date.now() - new Date(state.startIso).getTime() >= RUN_DURATION_MS;
}

// ---------------------------------------------------------------------------
// API pre-checks
// ---------------------------------------------------------------------------

async function apiPreChecks(state: AutopilotState): Promise<{
  balance: KalshiBalance;
  positions: KalshiPosition[];
  orders: KalshiOrder[];
} | null> {
  try {
    const [balance, positions, orders] = await Promise.all([
      getBalance(),
      getPositions(),
      getOrders("resting"),
    ]);
    return { balance, positions, orders };
  } catch (err) {
    state.apiErrors.push(new Date().toISOString());
    state.lastError = (err as Error).message;
    if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) {
      throw err; // fatal — bubble up for immediate shutdown
    }
    console.warn(`[autopilot] API pre-check failed: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error rate check
// ---------------------------------------------------------------------------

function checkErrorRate(state: AutopilotState): boolean {
  const now = Date.now();
  state.apiErrors = state.apiErrors.filter(
    (ts) => now - new Date(ts).getTime() < ERROR_WINDOW_MS,
  );
  return state.apiErrors.length >= MAX_ERRORS_IN_WINDOW;
}

// ---------------------------------------------------------------------------
// Manage pending entries
// ---------------------------------------------------------------------------

async function managePendingEntries(
  state: AutopilotState,
  liveOrders: KalshiOrder[],
  livePositions: KalshiPosition[],
): Promise<void> {
  const liveOrderIds = new Set(liveOrders.map((o) => o.order_id));
  const liveTickerSet = new Set(livePositions.map((p) => p.ticker));
  const now = Date.now();
  const toRemove: string[] = [];

  // Kalshi resting orders take ~2-4 min to propagate to GET /portfolio/orders.
  // Don't treat a missing orderId as "cancelled externally" until at least 5 min old.
  const CANCEL_GRACE_MS = 5 * 60 * 1000;

  for (const [ticker, entry] of Object.entries(state.pendingEntries)) {
    const ageMs = now - new Date(entry.placedTs).getTime();
    const hasFill = liveTickerSet.has(ticker);
    const orderMissing = !liveOrderIds.has(entry.orderId);
    const orderGone = hasFill || (orderMissing && ageMs > CANCEL_GRACE_MS);

    // Timeout: cancel if still resting and too old
    if (ageMs > ENTRY_TIMEOUT_SEC * 1000 && !liveTickerSet.has(ticker)) {
      if (!orderGone) {
        try {
          await cancelOrder(entry.orderId);
        } catch (err) {
          console.warn(`[autopilot] Cancel entry ${entry.orderId} failed: ${(err as Error).message}`);
        }
      }
      toRemove.push(ticker);
      appendTrade({
        ticker,
        side: entry.side,
        edgePct: entry.edgePct,
        entryPriceDollars: toFixed4(entry.priceCents / 100),
        count_fp: entry.countFp,
        orderIds: [entry.orderId],
        status: "entry_timeout",
        reasons: ["entry order exceeded ENTRY_TIMEOUT_SEC"],
      });
      notifyDiscord(
        `⏱️ **ENTRY TIMEOUT** | ${ticker}\n` +
        `Side: ${entry.side.toUpperCase()} @ $${toFixed4(entry.priceCents / 100)} — no fill in ${ENTRY_TIMEOUT_SEC}s, cancelled`,
      );
      continue;
    }

    if (orderGone) {
      if (liveTickerSet.has(ticker)) {
        // Filled → promote to open position
        state.openPositions[ticker] = {
          ticker,
          side: entry.side,
          entryPriceCents: entry.priceCents,
          countFp: entry.countFp,
          costUsd: entry.costUsd,
          entryOrderId: entry.orderId,
          entryFillTs: new Date().toISOString(),
          exitAttempts: 0,
          status: "awaiting_exit",
        };
        toRemove.push(ticker);
        state.lastTradeIso = new Date().toISOString();
        appendTrade({
          ticker,
          side: entry.side,
          edgePct: entry.edgePct,
          entryPriceDollars: toFixed4(entry.priceCents / 100),
          count_fp: entry.countFp,
          orderIds: [entry.orderId],
          status: "filled",
          reasons: ["entry order filled, position opened"],
        });
        console.log(`[autopilot] ${ticker} entry filled → position opened`);
        notifyDiscord(
          `✅ **ENTRY FILLED** | ${ticker}\n` +
          `Side: **${entry.side.toUpperCase()}** @ $${toFixed4(entry.priceCents / 100)} × ${entry.countFp} contracts\n` +
          `Cost: $${entry.costUsd.toFixed(2)} | Edge: ${entry.edgePct.toFixed(1)}% — position open, watching for exit`,
        );
      } else {
        // Vanished with no position → cancelled externally; start cooldown
        state.entryCooldowns[ticker] = Date.now();
        toRemove.push(ticker);
        appendTrade({
          ticker,
          side: entry.side,
          edgePct: entry.edgePct,
          entryPriceDollars: toFixed4(entry.priceCents / 100),
          count_fp: entry.countFp,
          orderIds: [entry.orderId],
          status: "cancelled",
          reasons: ["order cancelled externally"],
        });
        notifyDiscord(
          `❌ **ORDER CANCELLED** | ${ticker}\n` +
          `Side: ${entry.side.toUpperCase()} @ $${toFixed4(entry.priceCents / 100)} — cancelled externally (no position opened)`,
        );
      }
    }
  }

  for (const ticker of toRemove) {
    delete state.pendingEntries[ticker];
  }
}

// ---------------------------------------------------------------------------
// Exit order helper
// ---------------------------------------------------------------------------

async function placeExitOrder(
  pos: PositionState,
  state: AutopilotState,
  breakeven = false,
): Promise<void> {
  const priceCents = breakeven ? pos.entryPriceCents : pos.entryPriceCents + TP_CENTS;
  const priceDollars = toFixed4(priceCents / 100);
  const clientOrderId = uuidv4();

  const payload = {
    ticker: pos.ticker,
    side: pos.side,
    action: "sell" as const,
    type: "limit" as const,
    [pos.side === "yes" ? "yes_price_dollars" : "no_price_dollars"]: priceDollars,
    count_fp: pos.countFp,
    client_order_id: clientOrderId,
    post_only: true,
  };

  const exitOrder = await createOrder(payload);
  pos.exitOrderId = exitOrder.order_id;
  pos.exitAttempts++;
  pos.status = "exit_placed";
  console.log(
    `[autopilot] ${pos.ticker} exit order placed @ ${priceDollars}${breakeven ? " (breakeven)" : " (TP)"}`,
  );
}

// ---------------------------------------------------------------------------
// Manage open positions
// ---------------------------------------------------------------------------

async function manageOpenPositions(
  state: AutopilotState,
  liveOrders: KalshiOrder[],
  livePositions: KalshiPosition[],
  markets: ProcessedMarket[],
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

      if (illiquid) {
        pos.status = "holding_illiquid";
        console.log(`[autopilot] ${ticker} illiquid (spread=${spread}¢), holding`);
      } else {
        try {
          await placeExitOrder(pos, state);
        } catch (err) {
          console.warn(`[autopilot] Exit order for ${ticker} failed: ${(err as Error).message}`);
          if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) throw err;
        }
      }
    } else if (pos.status === "exit_placed") {
      const exitOrderGone = pos.exitOrderId ? !liveOrderIds.has(pos.exitOrderId) : true;

      if (exitOrderGone && !liveTickerSet.has(ticker)) {
        // Exit filled!
        const exitPriceCents = pos.entryPriceCents + TP_CENTS;
        const pnlUsd = ((exitPriceCents - pos.entryPriceCents) / 100) * parseFloat(pos.countFp);
        state.realizedPnlUsd += pnlUsd;
        state.consecutiveLosses = pnlUsd >= 0 ? 0 : state.consecutiveLosses + 1;
        state.lastTradeIso = new Date().toISOString();
        appendTrade({
          ticker,
          side: pos.side,
          entryPriceDollars: toFixed4(pos.entryPriceCents / 100),
          count_fp: pos.countFp,
          orderIds: [pos.entryOrderId, pos.exitOrderId].filter(Boolean),
          status: "closed",
          pnlUsd,
          reasons: ["exit filled at TP"],
        });
        toClose.push(ticker);
        console.log(`[autopilot] ${ticker} closed — PnL $${pnlUsd.toFixed(4)}`);
        const pnlSign = pnlUsd >= 0 ? "+" : "";
        const emoji = pnlUsd >= 0 ? "💰" : "🔴";
        notifyDiscord(
          `${emoji} **TRADE CLOSED** | ${ticker}\n` +
          `Side: ${pos.side.toUpperCase()} | Entry: $${toFixed4(pos.entryPriceCents / 100)} → Exit: $${toFixed4((pos.entryPriceCents + TP_CENTS) / 100)}\n` +
          `P&L: **${pnlSign}$${pnlUsd.toFixed(4)}** | Session total: ${state.realizedPnlUsd >= 0 ? "+" : ""}$${state.realizedPnlUsd.toFixed(4)}`,
        );
        continue;
      }

      // Check exit order age for timeout
      if (pos.exitOrderId && liveOrderIds.has(pos.exitOrderId)) {
        const exitOrder = liveOrders.find((o) => o.order_id === pos.exitOrderId);
        if (exitOrder) {
          const exitAgeMs = Date.now() - new Date(exitOrder.created_time).getTime();
          if (exitAgeMs > EXIT_TIMEOUT_SEC * 1000) {
            try {
              await cancelOrder(pos.exitOrderId);
              await placeExitOrder(pos, state, true /* breakeven */);
            } catch (err) {
              console.warn(`[autopilot] Breakeven exit for ${ticker} failed: ${(err as Error).message}`);
              if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) throw err;
            }
          }
        }
      }
    } else if (pos.status === "holding_illiquid") {
      // Check if position was closed externally
      if (!liveTickerSet.has(ticker)) {
        toClose.push(ticker);
        console.log(`[autopilot] ${ticker} position closed externally`);
        continue;
      }
      // Re-check liquidity each cycle
      const spread = market?.spread ?? 999;
      const bidPrice = pos.side === "yes" ? market?.yesBid : market?.noBid;
      if (market && spread <= 3 && bidPrice != null && bidPrice > 0) {
        pos.status = "awaiting_exit"; // will attempt exit next cycle
        console.log(`[autopilot] ${ticker} liquidity restored, will place exit`);
      }
    }
  }

  for (const ticker of toClose) {
    delete state.openPositions[ticker];
  }
}

// ---------------------------------------------------------------------------
// Caps check
// ---------------------------------------------------------------------------

function checkCaps(
  state: AutopilotState,
  liveOrders: KalshiOrder[],
): CapResult {
  const now = Date.now();

  // Prune hourly ring buffer
  state.ordersInLastHour = state.ordersInLastHour.filter(
    (ts) => now - new Date(ts).getTime() < 3_600_000,
  );

  const totalExposureUsd =
    Object.values(state.openPositions).reduce((s, p) => s + p.costUsd, 0) +
    Object.values(state.pendingEntries).reduce((s, e) => s + e.costUsd, 0);

  const posCount =
    Object.keys(state.openPositions).length + Object.keys(state.pendingEntries).length;
  const restCount = liveOrders.length;
  const trades1h = state.ordersInLastHour.length;

  const reasons: string[] = [];
  if (totalExposureUsd >= MAX_TOTAL_EXPOSURE_USD)
    reasons.push(`exposure $${totalExposureUsd.toFixed(2)} >= $${MAX_TOTAL_EXPOSURE_USD}`);
  if (posCount >= MAX_OPEN_POSITIONS)
    reasons.push(`open+pending ${posCount} >= ${MAX_OPEN_POSITIONS}`);
  if (restCount >= MAX_RESTING_ORDERS)
    reasons.push(`resting orders ${restCount} >= ${MAX_RESTING_ORDERS}`);
  if (trades1h >= MAX_ORDERS_PER_HOUR)
    reasons.push(`orders/hr ${trades1h} >= ${MAX_ORDERS_PER_HOUR}`);

  const slotsAvailable = Math.max(
    0,
    Math.min(
      MAX_OPEN_POSITIONS - posCount,
      MAX_RESTING_ORDERS - restCount,
      MAX_ORDERS_PER_HOUR - trades1h,
    ),
  );

  return { canTrade: reasons.length === 0, reasons, slotsAvailable };
}

// ---------------------------------------------------------------------------
// Game key helper — strips the winner-suffix so mirror markets share a key.
// "KXNBAGAME-26MAR03NOPLAL-LAL" and "KXNBAGAME-26MAR03NOPLAL-NOP" → same key.
// ---------------------------------------------------------------------------

function gameKey(ticker: string): string {
  return ticker.includes("GAME-") ? ticker.replace(/-[A-Z]+$/, "") : ticker;
}

// ---------------------------------------------------------------------------
// Find opportunities
// ---------------------------------------------------------------------------

function findOpportunities(
  markets: ProcessedMarket[],
  state: AutopilotState,
  liveOrders: KalshiOrder[],
): ProcessedMarket[] {
  const oneHourFromNow = Date.now() + 3_600_000;
  const liveOrderTickers = new Set(liveOrders.map((o) => o.ticker));

  // Claimed game keys — don't place a mirror-market duplicate for the same game
  const claimedGameKeys = new Set([
    ...Object.keys(state.pendingEntries).map(gameKey),
    ...Object.keys(state.openPositions).map(gameKey),
    ...liveOrders.map((o) => gameKey(o.ticker)),
  ]);

  return markets
    .filter((m) => {
      if (m.ticker in state.pendingEntries || m.ticker in state.openPositions) return false;
      if (liveOrderTickers.has(m.ticker)) return false;
      if (claimedGameKeys.has(gameKey(m.ticker))) return false;
      if (!m.closeTime || new Date(m.closeTime).getTime() < oneHourFromNow) return false;

      const isTournament = m.ticker.toUpperCase().startsWith("KXMARMAD");

      if (isTournament) {
        // Tournament futures: lighter liquidity bar, only tournamentEdge
        if (!m.tournamentEdge || Math.abs(m.tournamentEdge.gap) < EDGE_THRESHOLD_PCT) return false;
        if ((m.openInterest ?? 0) < 500_000) return false;
        return true;
      }

      // Game winner markets: use bid/ask spread + open interest as liquidity proxy
      const marketSpread =
        m.spread ??
        (m.yesBid != null && m.yesAsk != null ? m.yesAsk - m.yesBid : null);
      if (marketSpread == null || marketSpread > 2) return false;
      if ((m.openInterest ?? 0) < 50_000) return false;
      if (!m.crossEdge || Math.abs(m.crossEdge.gap) < EDGE_THRESHOLD_PCT) return false;

      // Movement signal: skip if sharp money is moving against the model
      const mv = m.crossEdge.movementSignal;
      if (mv && !mv.movingToward && mv.velocity > 0.5) return false;

      return true;
    })
    .sort((a, b) => {
      // Compute effective gap (boosted by confirming movement)
      const effGap = (m: ProcessedMarket): number => {
        if (m.tournamentEdge) return Math.abs(m.tournamentEdge.gap);
        const raw = Math.abs(m.crossEdge?.gap ?? 0);
        const mv = m.crossEdge?.movementSignal;
        return mv?.movingToward && mv.velocity > 0.3 ? raw * 1.3 : raw;
      };
      return effGap(b) - effGap(a);
    })
    .slice(0, 2);
}

// ---------------------------------------------------------------------------
// Place entry orders
// ---------------------------------------------------------------------------

async function placeEntryOrders(
  opportunities: ProcessedMarket[],
  state: AutopilotState,
  caps: CapResult,
  liveOrders: KalshiOrder[],
): Promise<number> {
  const liveDedupeKeys = new Set(
    liveOrders.map((o) => `${o.ticker}-${o.side}-${o.yes_price ?? o.no_price ?? 0}`),
  );
  const cycleGameKeys = new Set<string>(); // within-cycle mirror-market dedup

  let placed = 0;
  for (const market of opportunities) {
    if (placed >= caps.slotsAvailable) break;

    const gk = gameKey(market.ticker);
    if (cycleGameKeys.has(gk)) {
      console.log(`[autopilot] ${market.ticker} skipped — mirror market (${gk} already placed this cycle)`);
      continue;
    }

    const isTournament = market.ticker.toUpperCase().startsWith("KXMARMAD");
    const edgeGap = isTournament ? market.tournamentEdge!.gap : market.crossEdge!.gap;
    const edgeDirection = isTournament ? market.tournamentEdge!.direction : market.crossEdge!.direction;
    const positionType: "game" | "tournament" = isTournament ? "tournament" : "game";

    const side: "yes" | "no" = edgeDirection === "model-higher" ? "yes" : "no";

    // Model's probability for the side we're buying (0-100 cents)
    const modelProb = isTournament
      ? market.tournamentEdge!.modelChampionPct
      : market.crossEdge!.modelConfidence;
    const modelSideProb = side === "yes" ? modelProb : 100 - modelProb;

    // Aggressive (ask-crossing) price selection:
    //   Try the ask price first. If asking price is still below our model's
    //   value by at least EDGE_THRESHOLD_PCT, cross the spread for an
    //   immediate fill (1-2¢ cost vs. passive orders that never fill).
    //   Fall back to bid only if ask is too expensive.
    const askCents = side === "yes" ? market.yesAsk : market.noAsk;
    const bidCents = side === "yes" ? market.yesBid : market.noBid;
    const fallbackCents = market.impliedProbYes != null
      ? (side === "yes" ? market.impliedProbYes : 100 - market.impliedProbYes)
      : null;

    let priceCents: number | null;
    let fillMode: "aggressive" | "passive";
    if (askCents != null && askCents > 0 && (modelSideProb - askCents) >= EDGE_THRESHOLD_PCT) {
      priceCents = askCents;
      fillMode = "aggressive";
    } else {
      priceCents = bidCents ?? fallbackCents;
      fillMode = "passive";
    }

    if (priceCents == null || priceCents <= 0) {
      console.log(`[autopilot] ${market.ticker} skipped — no price on ${side} side`);
      continue;
    }

    const effectiveEdge = modelSideProb - priceCents;
    console.log(
      `[autopilot] ${market.ticker} ${side} ${fillMode}: ask=${askCents}¢ bid=${bidCents}¢ ` +
      `model=${modelSideProb.toFixed(1)}¢ effectiveEdge=${effectiveEdge.toFixed(1)}%`,
    );

    // Tournament bets are always capped at $1; game bets get high-edge bonus
    const rawCost = isTournament
      ? 1.00
      : (Math.abs(edgeGap) >= HIGH_EDGE_THRESHOLD_PCT ? HIGH_EDGE_COST_USD : DEFAULT_COST_USD);
    const costUsd = Math.min(rawCost, MAX_COST_PER_ORDER_USD);
    const countFpNum = costUsd / (priceCents / 100);
    if (countFpNum <= 0) {
      console.log(`[autopilot] ${market.ticker} skipped — countFp <= 0`);
      continue;
    }

    // Kalshi requires integer contract counts — floor to whole number
    const countInt = Math.max(1, Math.floor(countFpNum));
    const countFp = countInt.toFixed(2);
    const dedupeKey = `${market.ticker}-${side}-${priceCents}`;
    if (liveDedupeKeys.has(dedupeKey)) {
      console.log(`[autopilot] ${market.ticker} skipped — duplicate resting order`);
      continue;
    }

    const ENTRY_COOLDOWN_MS = 30 * 60 * 1000; // 30 min after external cancel
    const lastCancel = state.entryCooldowns[market.ticker] ?? 0;
    if (Date.now() - lastCancel < ENTRY_COOLDOWN_MS) {
      const remainMin = Math.ceil((ENTRY_COOLDOWN_MS - (Date.now() - lastCancel)) / 60_000);
      console.log(`[autopilot] ${market.ticker} skipped — in 30min cooldown after cancel (${remainMin}min left)`);
      continue;
    }

    const clientOrderId = uuidv4();
    const priceDollars = toFixed4(priceCents / 100);
    const payload = {
      ticker: market.ticker,
      side,
      action: "buy" as const,
      type: "limit" as const,
      [side === "yes" ? "yes_price_dollars" : "no_price_dollars"]: priceDollars,
      count_fp: countFp,
      client_order_id: clientOrderId,
    };

    try {
      console.log(`[autopilot] Placing order: ${JSON.stringify(payload)}`);
      const order = await createOrder(payload);
      state.pendingEntries[market.ticker] = {
        ticker: market.ticker,
        orderId: order.order_id,
        clientOrderId,
        side,
        priceCents,
        countFp,
        costUsd,
        placedTs: new Date().toISOString(),
        dedupeKey,
        edgePct: edgeGap,
        positionType,
      };
      state.ordersInLastHour.push(new Date().toISOString());
      cycleGameKeys.add(gk);
      placed++;
      appendTrade({
        ticker: market.ticker,
        side,
        edgePct: edgeGap,
        positionType,
        actionability: market.actionability,
        entryPriceDollars: priceDollars,
        count_fp: countFp,
        orderIds: [order.order_id],
        status: "entry_placed",
        reasons: [`edge ${edgeGap.toFixed(1)}%, direction ${edgeDirection}`, `type: ${positionType}`, `fill: ${fillMode}`],
      });
      console.log(
        `[autopilot] Entry placed: ${market.ticker} ${side} @ ${priceDollars} ×${countFp} (edge=${edgeGap.toFixed(1)}%, ${positionType})`,
      );
      notifyDiscord(
        `📋 **ENTRY PLACED** | ${market.ticker}\n` +
        `Side: **${side.toUpperCase()}** @ $${priceDollars} × ${countFp} contracts | Cost: $${costUsd.toFixed(2)}\n` +
        `Edge: ${edgeGap.toFixed(1)}% (${edgeDirection}) | Type: ${positionType}`,
      );
    } catch (err) {
      state.lastError = (err as Error).message;
      state.apiErrors.push(new Date().toISOString());
      console.warn(`[autopilot] Order failed for ${market.ticker}: ${(err as Error).message}`);
      if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) {
        throw err; // fatal
      }
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function printStatus(
  state: AutopilotState,
  balanceCents: number,
  liveOrders: KalshiOrder[],
): void {
  const now = Date.now();
  const cashUsd = balanceCents / 100;
  const exposure =
    Object.values(state.openPositions).reduce((s, p) => s + p.costUsd, 0) +
    Object.values(state.pendingEntries).reduce((s, e) => s + e.costUsd, 0);
  const posCount = Object.keys(state.openPositions).length;
  const restCount = liveOrders.length;
  const trades1h = state.ordersInLastHour.filter(
    (ts) => now - new Date(ts).getTime() < 3_600_000,
  ).length;
  const errCount = state.apiErrors.filter(
    (ts) => now - new Date(ts).getTime() < ERROR_WINDOW_MS,
  ).length;

  console.log(
    `[${nowET()} ET] cash=$${cashUsd.toFixed(2)} exp=$${exposure.toFixed(2)} ` +
      `pos=${posCount} rest=${restCount} trades1h=${trades1h} err=${errCount}`,
  );
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function gracefulShutdown(state: AutopilotState, reason: string): Promise<never> {
  console.log(`\n[autopilot] Shutting down: ${reason}`);
  try {
    const cancelled = await cancelAllRestingOrders();
    console.log(`[autopilot] Cancelled ${cancelled} resting order(s)`);
  } catch (err) {
    console.warn(`[autopilot] cancelAllRestingOrders failed: ${(err as Error).message}`);
  }
  saveState(state);
  const elapsed = ((Date.now() - new Date(state.startIso).getTime()) / 3_600_000).toFixed(1);
  const summary =
    `[autopilot] Summary — runtime: ${elapsed}h | PnL: $${state.realizedPnlUsd.toFixed(4)} | ` +
    `open positions: ${Object.keys(state.openPositions).length}`;
  console.log(summary);
  notifyDiscord(
    `🛑 **AUTOPILOT STOPPED** — ${reason}\n` +
    `Runtime: ${elapsed}h | Session P&L: ${state.realizedPnlUsd >= 0 ? "+" : ""}$${state.realizedPnlUsd.toFixed(4)} | ` +
    `Open positions: ${Object.keys(state.openPositions).length}`,
  );
  // Give the notification a moment to send before exit
  await sleep(1_500);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[autopilot] Kalshi 48h autopilot starting...");
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  // Load backtest results and adjust edge threshold if accuracy is poor
  let backtestMsg = "";
  const backtestResults = loadBacktestResults();
  if (backtestResults && backtestResults.gamesTracked >= 5) {
    backtestMsg = applyBacktestAdjustments(backtestResults);
    console.log(`[autopilot] Backtest: ${backtestMsg}`);
  }

  const state = loadState();
  if (!state.startIso) state.startIso = new Date().toISOString();

  console.log(`[autopilot] Run started at ${state.startIso}`);
  console.log(
    `[autopilot] Caps: max_exposure=$${MAX_TOTAL_EXPOSURE_USD} ` +
      `max_pos=${MAX_OPEN_POSITIONS} max_resting=${MAX_RESTING_ORDERS} max_orders_hr=${MAX_ORDERS_PER_HOUR} ` +
      `edge_threshold=${EDGE_THRESHOLD_PCT}%`,
  );

  // Post startup message to Discord
  {
    const startLines = [
      `🚀 **Autopilot started** — 48h run`,
      `Caps: exp=$${MAX_TOTAL_EXPOSURE_USD} pos=${MAX_OPEN_POSITIONS} edge=${EDGE_THRESHOLD_PCT}%`,
    ];
    if (backtestMsg) startLines.push(`📊 ${backtestMsg}`);
    notifyDiscord(startLines.join("\n"));
  }

  while (true) {
    // ── 1. Kill switch ──────────────────────────────────────────────────────
    if (checkKillSwitch()) {
      await gracefulShutdown(state, "kill switch triggered");
    }

    // ── 2. Runtime limit ────────────────────────────────────────────────────
    if (checkRuntime(state)) {
      await gracefulShutdown(state, "48h runtime limit reached");
    }

    // ── 3. Refresh market data if stale ─────────────────────────────────────
    maybeRefreshMarkets();
    const markets = loadMarkets();

    // ── 4. API pre-checks ───────────────────────────────────────────────────
    let apiData: {
      balance: KalshiBalance;
      positions: KalshiPosition[];
      orders: KalshiOrder[];
    } | null = null;

    try {
      apiData = await apiPreChecks(state);
    } catch (err) {
      // 401/403 fatal auth error
      await gracefulShutdown(state, `fatal auth error: ${(err as Error).message}`);
    }

    if (!apiData) {
      // Non-fatal failure — check error rate then sleep
      if (checkErrorRate(state)) {
        await gracefulShutdown(
          state,
          `too many API errors (${MAX_ERRORS_IN_WINDOW} in ${ERROR_WINDOW_MS / 60_000}min)`,
        );
      }
      saveState(state);
      await sleep(LOOP_INTERVAL_MS);
      continue;
    }

    const { balance, positions, orders } = apiData;

    // ── 5. Error rate check ──────────────────────────────────────────────────
    if (checkErrorRate(state)) {
      await gracefulShutdown(state, "too many API errors in window");
    }

    // ── 6. Manage pending entries ────────────────────────────────────────────
    try {
      await managePendingEntries(state, orders, positions);
    } catch (err) {
      state.apiErrors.push(new Date().toISOString());
      state.lastError = (err as Error).message;
      console.warn(`[autopilot] managePendingEntries error: ${(err as Error).message}`);
      if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) {
        await gracefulShutdown(state, "fatal auth error in managePendingEntries");
      }
    }

    // ── 7. Manage open positions ─────────────────────────────────────────────
    try {
      await manageOpenPositions(state, orders, positions, markets);
    } catch (err) {
      state.apiErrors.push(new Date().toISOString());
      state.lastError = (err as Error).message;
      console.warn(`[autopilot] manageOpenPositions error: ${(err as Error).message}`);
      if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) {
        await gracefulShutdown(state, "fatal auth error in manageOpenPositions");
      }
    }

    // ── 8. Caps check ────────────────────────────────────────────────────────
    const caps = checkCaps(state, orders);

    // ── 9 & 10. Find opportunities and place orders ──────────────────────────
    let cycleOpportunities: ProcessedMarket[] = [];
    let cycleOrdersPlaced = 0;
    if (caps.canTrade) {
      cycleOpportunities = findOpportunities(markets, state, orders);
      if (cycleOpportunities.length > 0) {
        try {
          cycleOrdersPlaced = await placeEntryOrders(cycleOpportunities, state, caps, orders);
          sessionOrdersPlaced += cycleOrdersPlaced;
        } catch (err) {
          if (err instanceof KalshiApiError && (err.status === 401 || err.status === 403)) {
            await gracefulShutdown(state, "fatal auth error placing orders");
          }
        }
      } else if (markets.length === 0) {
        console.log("[autopilot] No market data available");
      }
    } else {
      console.log(`[autopilot] Trading paused: ${caps.reasons.join("; ")}`);
    }

    // ── 11. Save state ───────────────────────────────────────────────────────
    saveState(state);

    // ── 12. Status line ──────────────────────────────────────────────────────
    printStatus(state, balance.balance, orders);

    // ── 12b. Discord status (fire-and-forget) ────────────────────────────────
    {
      const cashUsd = balance.balance / 100;
      const exposure =
        Object.values(state.openPositions).reduce((s, p) => s + p.costUsd, 0) +
        Object.values(state.pendingEntries).reduce((s, e) => s + e.costUsd, 0);
      const posCount = Object.keys(state.openPositions).length;
      const lines: string[] = [
        `📊 Autopilot scan — ${nowET()} ET`,
        `Cash: $${cashUsd.toFixed(2)} | Exposure: $${exposure.toFixed(2)} | Positions: ${posCount}`,
        `Cross-edge signals: ${cycleOpportunities.length} | Orders placed: ${sessionOrdersPlaced} (session)`,
      ];
      for (const opp of cycleOpportunities.slice(0, 3)) {
        const isTournament = opp.ticker.toUpperCase().startsWith("KXMARMAD");
        if (isTournament && opp.tournamentEdge) {
          const te = opp.tournamentEdge;
          const side = te.direction === "model-higher" ? "YES" : "NO";
          lines.push(
            `⚡ ${opp.ticker}: +${Math.abs(te.gap).toFixed(1)}% edge (${side}) | ` +
            `${te.team} model=${te.modelChampionPct.toFixed(1)}% kalshi=${te.kalshiImplied.toFixed(1)}%`,
          );
        } else if (opp.crossEdge) {
          const ce = opp.crossEdge;
          const side = ce.direction === "model-higher" ? "YES" : "NO";
          const priceCents = ce.direction === "model-higher" ? opp.yesAsk : opp.noAsk;
          let injStr = "";
          if (ce.injuryContext) {
            if (ce.injuryContext.oppInjuredStars.length > 0) {
              injStr = ` | OPP OUT: ${ce.injuryContext.oppInjuredStars.slice(0, 2).join(", ")}`;
            } else if (ce.injuryContext.pickInjuredStars.length > 0) {
              injStr = ` | PICK INJ: ${ce.injuryContext.pickInjuredStars.slice(0, 2).join(", ")}`;
            }
          }
          lines.push(
            `⚡ ${opp.ticker}: +${Math.abs(ce.gap).toFixed(1)}% edge (${side} @ ${priceCents != null ? Math.round(priceCents) : "?"}¢)${injStr}`,
          );
        }
      }
      if (cycleOpportunities.length === 0 && caps.canTrade) {
        lines.push("No cross-edge signals this cycle");
      } else if (!caps.canTrade) {
        lines.push(`Trading paused: ${caps.reasons[0] ?? "cap reached"}`);
      }
      if (state.lastError) {
        lines.push(`⚠️ Last error: ${state.lastError}`);
      }
      postDiscordStatus(lines.join("\n"));
    }

    // ── 13. Sleep ────────────────────────────────────────────────────────────
    await sleep(LOOP_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[autopilot] Unhandled error:", err);
  process.exit(1);
});
