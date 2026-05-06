/**
 * run-kalshi-autopilot-ws.ts — WebSocket-Driven Information-Speed Autopilot
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY WS OVER POLLING:
 *   Polling (30s): You learn of a price move 0–30 seconds late.
 *   WebSocket:     You learn of a price move in <100ms.
 *
 *   The information-speed edge only exists in the first few seconds after
 *   sportsbooks move. By the time the poll fires, arbitrageurs have already
 *   closed the gap. WS captures the edge before it disappears.
 *
 * ARCHITECTURE:
 *   • Kalshi WS       → wss://api.elections.kalshi.com/trade-api/ws/v2
 *                       channels: orderbook_snapshot + orderbook_delta
 *                       auth: RSA-PSS SHA256 signed timestamp
 *   • TheRundown WS   → wss://therundown.io/api/v2/ws/markets?key=KEY
 *                       affiliate_ids=3 (Pinnacle), market_ids=1 (moneyline)
 *                       pushes price deltas in <8ms on every Pinnacle move
 *   • Books fallback  → reads data/processed/latest-odds-api*.json every 5min
 *                       (only used for markets not matched by TheRundown)
 *   • Trade exec      → Kalshi REST (execute-kalshi.ts)
 *   • Exits           → REST-polled every 30s
 *
 * STARTUP FLOW:
 *   1. Load Kalshi markets from data/processed/latest-kalshi.json
 *   2. Fetch today's events from TheRundown REST → prime eventMap + booksMap
 *   3. Connect TheRundown WS → stream live Pinnacle moneyline deltas
 *   4. Connect Kalshi WS → subscribe orderbook_delta for all tracked markets
 *   5. On TheRundown price update → devig → update booksMid → checkSignal()
 *   6. On Kalshi orderbook event → update kalshiMid → checkSignal()
 *   7. Background: exit loop polls REST every 30s for fills
 *
 * SIGNAL LOGIC:
 *   • detectLeader() — step-function recency detector (books vs kalshi)
 *   • ONLY trade when BOOKS leads (books-leads = edge; kalshi-leads = poison)
 *   • Kelly sizing with 7% Kalshi fee baked in
 *   • Per-market loss limit: -$500
 *   • 5-second signal debounce per market (prevent signal storms)
 *
 * ENV:
 *   KALSHI_API_KEY_ID           → RSA key ID
 *   KALSHI_PRIVATE_KEY_PEM_PATH → path to RSA private key PEM
 *   THERUNDOWN_API_KEY          → TheRundown API key (ultra tier for WS)
 *   KALSHI_AUTOPILOT_STOP=1     → env var kill switch
 *
 * INSTALL:
 *   npm install ws @types/ws
 *   npx tsx scripts/run-kalshi-autopilot-ws.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";

// TheRundown
const TR_WS_URL        = "wss://therundown.io/api/v2/ws/markets";
const TR_API_BASE      = "https://therundown.io/api/v2";
const TR_AFFILIATE_ID  = 3;   // Pinnacle — sharpest line
const TR_MARKET_IDS    = "1,41"; // Prematch moneyline (1) + Live moneyline (41)
const TR_MARKET_ID     = 1;   // kept for REST snapshot (prematch prime only)
const TR_SPORT_IDS     = [1, 2, 3, 4, 5, 6, 10, 11, 13, 14, 15, 16, 33];
// 1=NCAAF, 2=NFL, 3=MLB, 4=NBA, 5=NCAAB, 6=NHL, 10=MLS, 11=EPL, 14=La Liga, 15=Serie A, 16=UCL, 33=Europa
// Reload event map if it hasn't been refreshed in 6h (covers midnight rollover)
const TR_EVENT_MAP_TTL_MS = 1 * 60 * 60 * 1000; // refresh hourly to pick up new Pinnacle lines

// Safety caps (same as polling version)
const MAX_COST_PER_ORDER_USD  = 8.00;
const PREGAME_MAX_COST_USD    = 8.00;
const MAX_TOTAL_EXPOSURE_USD  = 8.00;
const MAX_OPEN_POSITIONS      = 1;
const MAX_RESTING_ORDERS      = 1;
const MAX_ORDERS_PER_HOUR     = 20;
const MAX_EVENT_EXPOSURE_USD  = 8.00;

// Edge thresholds
const EDGE_THRESHOLD_PCT      = 8;
const HIGH_EDGE_THRESHOLD_PCT = 20;
const DEFAULT_COST_USD        = 8.00;
const HIGH_EDGE_COST_USD      = 8.00;

// Loss / timing limits
const MARKET_LOSS_LIMIT_USD   = -500;
const ENTRY_COOLDOWN_MS       = 300_000;   // 5 min cooldown per event after successful entry
const FAILED_ENTRY_COOLDOWN_MS = 60_000;   // 1 min cooldown after a failed/rejected order
const ENTRY_TIMEOUT_SEC       = 28_800;   // 8h to fill
const EXIT_TIMEOUT_SEC        = 300;      // 5 min exit window — get in, capture edge, get out
const PREGAME_MAX_AHEAD_MS    = 30 * 60_000; // only enter pregame within 30 min of tip
const TP_EDGE_CAPTURE_PCT     = 0.60;     // exit when 60% of edge (entry→fair) is captured
const TRAILING_STOP_PULLBACK  = 0.35;     // exit if profit pulls back 35% from peak
const SL_CENTS                = 5;        // stop-loss: cut if unrealized < -5¢
const RUN_DURATION_MS         = 172_800_000; // 48h max session

// WS / polling config
const SIGNAL_DEBOUNCE_MS       = 200;      // min ms between checks per market
const MIN_LIVE_TICKS           = 2;        // live Pinnacle ticks before trusting a signal (avoids first-tick phantoms)
// Max game age before blocking new entries (avoid betting in final minutes)
const GAME_MAX_AGE_MS: Record<string, number> = {
  NCAAMB: 80  * 60_000,  // NCAAB: block after ~80 min (avoids last 5 min of 2nd half)
  NBA:    115 * 60_000,  // NBA:   block after ~115 min (avoids last 5 min of 4th quarter)
  NHL:    130 * 60_000,  // NHL:   block after ~130 min (avoids last 5 min of 3rd period)
  MLB:    165 * 60_000,  // MLB:   ~165 min (9 innings, average ~2h45)
  NFL:    165 * 60_000,  // NFL:   ~165 min (60min play + breaks + buffer)
  DEFAULT: 110 * 60_000, // fallback
};
const EXIT_POLL_INTERVAL_MS    = 15_000;   // REST exit poll
const ODDS_REFRESH_INTERVAL_MS = 300_000;  // fallback file re-read interval (5 min — TR WS is primary)
const INGEST_INTERVAL_MS       = 300_000;  // 5 min
const STATUS_INTERVAL_LOOPS    = 60;       // status every ~5min (60 × 5s loops)
const WS_RECONNECT_INITIAL_MS  = 2_000;
const WS_RECONNECT_MAX_MS      = 60_000;
const WS_PING_INTERVAL_MS      = 30_000;   // keepalive ping
const PRICE_HISTORY_MAX        = 50;       // ticks per market
const ORDERBOOK_DEPTH          = 10;       // track top-N price levels

// Dry-run mode: set DRY_RUN=1 to simulate trades without hitting Kalshi API
const DRY_RUN = process.env.DRY_RUN === "1";

// File paths
const STOP_FILE     = path.resolve(process.cwd(), "data", "STOP_KALSHI_AUTOPILOT.txt");
const STATE_FILE    = path.resolve(process.cwd(), "data", "processed", "kalshi-state-ws.json");
const TRADES_FILE   = path.resolve(process.cwd(), "data", "processed", "kalshi-trades-ws.jsonl");
const MARKETS_FILE  = path.resolve(process.cwd(), "data", "processed", "latest-kalshi.json");
const LOG_FILE      = path.resolve(process.cwd(), "data", "processed", "autopilot-ws.log");
const ODDS_DATA_DIR = path.resolve(process.cwd(), "data", "processed");

// Discord gateway (local) — optional, falls back to DISCORD_WEBHOOK_URL on EC2
const GATEWAY_URL     = "http://127.0.0.1:18789/tools/invoke";
const GATEWAY_TOKEN   = "9f3c7ab1d2e84f16b5c0a7d43e9f2c1867b4d0ac53e18f92";
const DISCORD_CHANNEL = "channel:1474075668135284827";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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
  actionability?: string;
  crossEdge?: CrossEdge | null;
}

interface OddsApiGame {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  commence_time?: string;
  bookmakers?: {
    key: string;
    markets?: {
      key: string;
      outcomes?: { name: string; price: number }[];
    }[];
  }[];
}

// TheRundown event metadata (keyed by event_id)
interface TREvent {
  homeTeam: string;
  awayTeam: string;
  homeParticipantId: number;   // prematch market_id=1 participant ID
  awayParticipantId: number;
  liveHomeParticipantId: number; // live market_id=41 participant ID (different numbering)
  liveAwayParticipantId: number;
  commenceTimeMs: number;
  sportId: number;
}

// TheRundown V2 market_price WS message
interface TRPriceMsg {
  meta: { type: string; version?: string; timestamp?: number };
  data?: {
    event_id:              string;
    affiliate_id:          number;
    market_id:             number;
    market_participant_id: number;
    price:                 string | number;
    previous_price?:       string | number;
    is_main_line?:         boolean;
    sport_id?:             number;
    updated_at?:           string;
  };
}

// TheRundown V2 REST event response shape (simplified)
interface TRRestParticipant {
  id:    number;
  type:  string;
  name:  string;
  lines: { value: string; prices: Record<string, { price: number; is_main_line?: boolean }> }[];
}
interface TRRestMarket {
  market_id:    number;
  participants: TRRestParticipant[];
}
interface TRRestEvent {
  event_id:  string;
  sport_id:  number;
  event_date?: string;
  teams?: { team_normalized_id?: number; is_home?: boolean; name?: string }[];
  markets:   TRRestMarket[];
}

interface OddsApiFile {
  events: OddsApiGame[];
}

/** Per-market orderbook (price_cents → quantity). */
interface Orderbook {
  yes: Map<number, number>;
  no:  Map<number, number>;
}

/** Runtime state for a tracked market */
interface MarketState {
  ticker: string;
  title: string;
  subtitle: string;  // YES-side team name (most reliable for game markets)
  // Live prices (0–1 fraction)
  kalshiMid:    number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  booksMid:     number;  // sportsbook devigged consensus for YES team
  // Price history for leader detection
  priceHistory: { ts: number; booksMid: number; kalshiMid: number }[];
  // Timing
  lastSignalCheck:        number;
  receivedKalshiSnapshot: boolean;
  // Ingest cross-edge signal (Pinnacle structural gap at last ingest run)
  crossEdgeGapPct:   number;                               // 0 = no signal
  crossEdgeDirection: "model-higher" | "model-lower" | null;
  commenceTimeMs: number;  // game start time from TR (0 if unknown)
  liveTicksSeen:  number;  // count of live (market_id=41) Pinnacle WS ticks received
  signalFired:    boolean; // true once an entry signal has been emitted — blocks re-entry in same process
}

interface LeaderDetectionResult {
  leader: "BOOKS" | "KALSHI" | "UNKNOWN";
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
  leaderAtEntry?: "BOOKS" | "KALSHI" | "UNKNOWN";
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
  status: "awaiting_exit" | "exit_placed" | "holding_illiquid" | "pending_settlement";
  leaderAtEntry?: "BOOKS" | "KALSHI" | "UNKNOWN";
  directionAtEntry?: "UP" | "DOWN" | "FLAT";
  peakUnrealizedCents: number;  // highest unrealized profit (cents/contract) seen so far
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
  playedGames: Record<string, true>;  // game keys entered this session — never re-enter
  balanceUsd: number;                 // last known Kalshi cash balance
  totalExposureUsd: number;           // sum of open position costs
}

// ─────────────────────────────────────────────────────────────────────────────
// Global State
// ─────────────────────────────────────────────────────────────────────────────

const markets    = new Map<string, MarketState>();
const orderbooks = new Map<string, Orderbook>();
const phantomEdgeLoggedAt = new Map<string, number>(); // suppress repeated phantom edge logs

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
  playedGames: {},
  balanceUsd: 0,
  totalExposureUsd: 0,
};

let kalshiWs: WebSocket | null = null;
let kalshiPingTimer: ReturnType<typeof setInterval> | null = null;
let kalshiReconnectDelay = WS_RECONNECT_INITIAL_MS;
let wsMessageId = 1;
let running = true;
const placingTickers = new Set<string>();
const pendingGameEntry = new Set<string>(); // games currently being evaluated — blocks concurrent same-game signals

// Books odds state
let booksMap       = new Map<string, number>(); // normalized team name → devigged prob
let booksStartTime = new Map<string, number>(); // team name → game start timestamp (ms)
let lastBooksTs    = 0;

// TheRundown state
let therundownWs: WebSocket | null = null;
let trReconnectDelay  = WS_RECONNECT_INITIAL_MS;
let trConnected       = false;
// event_id → metadata (built from REST on startup)
const eventMap        = new Map<string, TREvent>();
// event_id → {0: homeImplied, 1: awayImplied} (normalized keys, home=0 away=1)
const pinnacleRaw     = new Map<string, Map<number, number>>();
// event_id → live market participant accumulator {participantId → impliedProb}
// used to learn live participant IDs before we can assign home/away
const liveAccum       = new Map<string, Map<number, number>>();
let eventMapLoadedAt  = 0; // timestamp of last eventMap refresh

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function uuidv4(): string { return crypto.randomUUID(); }

function nowET(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function sportFromTicker(ticker: string): string {
  if (ticker.includes("NCAAMB") || ticker.includes("CAAMB")) return "NCAAMB";
  if (ticker.includes("NBA"))    return "NBA";
  if (ticker.includes("NHL"))    return "NHL";
  if (ticker.includes("MLB") || ticker.includes("MLBST")) return "MLB";
  if (ticker.includes("NFL"))    return "NFL";
  return "DEFAULT";
}

const MONTHS_MAP: Record<string, number> = {
  JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11
};

/**
 * Parse the ET calendar date from a Kalshi ticker.
 * e.g. "KXNBAGAME-26MAR13CHILAC-CHI" → "2026-03-13"
 */
function parseDateFromTicker(ticker: string): string | null {
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const year  = 2000 + parseInt(m[1]);
  const month = MONTHS_MAP[m[2]];
  const day   = parseInt(m[3]);
  if (month === undefined || isNaN(day)) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Convert a UTC timestamp to an ET calendar date string (YYYY-MM-DD). */
function toEtDateStr(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function log(...args: unknown[]): void {
  const line = `[ws ${nowET()}] ${args.join(" ")}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

function warn(...args: unknown[]): void {
  const line = `[ws ${nowET()}] WARNING ${args.join(" ")}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

function wsGameKey(ticker: string): string {
  return ticker.includes("GAME-") ? ticker.replace(/-[A-Z0-9]+$/, "") : ticker;
}

function isKillSwitchSet(): boolean {
  if (process.env.KALSHI_AUTOPILOT_STOP === "1") return true;
  return fs.existsSync(STOP_FILE);
}

function saveState(): void {
  // Async write — don't block the signal path for a disk flush
  fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => { /* ignore */ });
}

function loadState(): void {
  // DRY_RUN always starts fresh with a clean $50 paper balance
  if (DRY_RUN) {
    state = {
      ...state,
      realizedPnlUsd:    0,
      openPositions:     {},
      pendingEntries:    {},
      entryCooldowns:    {},
      ordersInLastHour:  [],
      consecutiveLosses: 0,
      marketCumulativePnl: {},
      lastTradeIso:      null,
    };
    log(`⚠️  DRY RUN — paper account reset: $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)} virtual balance | $${MAX_COST_PER_ORDER_USD.toFixed(2)}/bet`);
    saveState();
    return;
  }
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as AutopilotState;
      state = { ...state, ...saved };
      log(`Loaded state: PnL=$${state.realizedPnlUsd.toFixed(2)} positions=${Object.keys(state.openPositions).length}`);
    }
  } catch { /* ignore */ }
}

function notifyDiscord(message: string): void {
  if (DISCORD_WEBHOOK_URL) {
    // Direct webhook — works on EC2 (no local gateway needed)
    fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(8_000),
    }).catch((err) => warn(`Discord webhook failed: ${(err as Error).message}`));
  } else {
    // Local gateway (dev machine)
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
}

function appendTrade(record: Record<string, unknown>): void {
  try {
    fs.appendFileSync(TRADES_FILE, JSON.stringify({ ...record, ts: new Date().toISOString() }) + "\n");
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi Auth — RSA-PSS SHA256, same signing scheme as REST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the three Kalshi auth headers needed for both REST requests and
 * the WebSocket HTTP-upgrade handshake.
 * Signs: {timestampMs}GET/trade-api/ws/v2
 */
function buildKalshiAuthHeaders(): Record<string, string> {
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PEM_PATH;
  if (!keyPath) throw new Error("KALSHI_PRIVATE_KEY_PEM_PATH not set");
  const apiKey = process.env.KALSHI_API_KEY_ID ?? "";
  if (!apiKey) throw new Error("KALSHI_API_KEY_ID not set");

  const ts      = String(Date.now());
  const pem     = fs.readFileSync(keyPath, "utf8");
  const message = `${ts}GET/trade-api/ws/v2`;

  const signer = crypto.createSign("SHA256");
  signer.update(message);
  const sig = signer.sign(
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );

  return {
    "KALSHI-ACCESS-KEY":       apiKey,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orderbook Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getOrCreateOrderbook(ticker: string): Orderbook {
  if (!orderbooks.has(ticker)) {
    orderbooks.set(ticker, { yes: new Map(), no: new Map() });
  }
  return orderbooks.get(ticker)!;
}

function bestYesBid(ob: Orderbook): number {
  if (ob.yes.size === 0) return 0;
  return Math.max(...ob.yes.keys());
}

function bestYesAsk(ob: Orderbook): number {
  if (ob.no.size === 0) return 100;
  return 100 - Math.max(...ob.no.keys());
}

function updateMktFromOrderbook(ticker: string): void {
  const ms = markets.get(ticker);
  if (!ms) return;
  const ob  = getOrCreateOrderbook(ticker);
  const bid = bestYesBid(ob);
  const ask = bestYesAsk(ob);
  if (bid > 0) ms.kalshiYesBid = bid / 100;
  if (ask < 100) ms.kalshiYesAsk = ask / 100;
  if (bid > 0 && ask < 100) ms.kalshiMid = (bid + ask) / 200;
  else if (bid > 0) ms.kalshiMid = bid / 100;
  else if (ask < 100) ms.kalshiMid = ask / 100;

  // Record every tick into price history here (not inside debounced checkSignal)
  // so the full tick-by-tick record is available when the signal evaluates.
  if (ms.kalshiMid > 0 && ms.booksMid > 0) {
    ms.priceHistory.push({ ts: Date.now(), booksMid: ms.booksMid, kalshiMid: ms.kalshiMid });
    if (ms.priceHistory.length > PRICE_HISTORY_MAX) ms.priceHistory.shift();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sportsbook Odds Polling (replaces Polymarket WS)
// ─────────────────────────────────────────────────────────────────────────────

const TEAM_ALIAS: Record<string, string> = {
  // Soccer
  "manchester united": "man united", "manchester city": "man city",
  "wolverhampton wanderers": "wolves", "nottingham forest": "nottingham",
  "brighton & hove albion": "brighton", "west bromwich albion": "west brom",
  "tottenham hotspur": "tottenham", "newcastle united": "newcastle",
  "galatasaray sk": "galatasaray", "galatasaray a.s.": "galatasaray",
  "liverpool fc": "liverpool", "real madrid cf": "real madrid",
  "fc barcelona": "barcelona", "atletico de madrid": "atletico madrid",
  "atletico madrid": "atletico", "club atletico de madrid": "atletico",
  "borussia dortmund": "dortmund", "rb leipzig": "leipzig",
  "paris saint-germain": "psg", "paris saint germain": "psg",
  "internazionale": "inter milan", "fc internazionale": "inter milan",
  "ac milan": "milan", "atalanta bc": "atalanta",
  "newcastle united fc": "newcastle", "arsenal fc": "arsenal",
  "chelsea fc": "chelsea", "aston villa": "aston villa",
};

// Kalshi uses 3-letter city codes for NHL (e.g. "VAN Canucks") and
// abbreviations for NBA/NCAAB (e.g. "Los Angeles L", "Oklahoma City").
// Map Kalshi subtitle (lowercased, stripped) → normalized team name used by TR.
const KALSHI_TEAM_ABBREV: Record<string, string> = {
  // NHL 3-letter city codes
  "van canucks": "vancouver canucks",   "van": "vancouver",
  "nsh predators": "nashville predators", "nsh": "nashville",
  "col avalanche": "colorado avalanche", "col": "colorado",
  "sea kraken": "seattle kraken",        "sea": "seattle",
  "chi blackhawks": "chicago blackhawks",
  "uta mammoth": "utah mammoth",         "uta": "utah",
  "pit penguins": "pittsburgh penguins", "pit": "pittsburgh",
  "vgk golden knights": "vegas golden knights", "vgk": "vegas golden knights",
  "wpg jets": "winnipeg jets",           "wpg": "winnipeg",
  "nyr rangers": "new york rangers",     "nyr": "new york rangers",
  "edm oilers": "edmonton oilers",       "edm": "edmonton",
  "dal stars": "dallas stars",
  "min wild": "minnesota wild",
  "stl blues": "st louis blues",         "stl": "st louis",
  "car hurricanes": "carolina hurricanes", "car": "carolina",
  "bos bruins": "boston bruins",
  "sj sharks": "san jose sharks",        "sj": "san jose",
  "det red wings": "detroit red wings",
  "tb lightning": "tampa bay lightning",  "tb": "tampa bay",
  "cgy flames": "calgary flames",        "cgy": "calgary",
  "nj devils": "new jersey devils",      "nj": "new jersey",
  "cbj blue jackets": "columbus blue jackets", "cbj": "columbus",
  "fla panthers": "florida panthers",    "fla": "florida",
  "tor maple leafs": "toronto maple leafs", "tor": "toronto",
  "ana ducks": "anaheim ducks",          "ana": "anaheim",
  "phi flyers": "philadelphia flyers",   "phi": "philadelphia",
  "buf sabres": "buffalo sabres",        "buf": "buffalo",
  "wsh capitals": "washington capitals", "wsh": "washington",
  "ott senators": "ottawa senators",     "ott": "ottawa",
  "mtl canadiens": "montreal canadiens", "mtl": "montreal",
  // NBA abbreviations Kalshi uses
  "los angeles l": "los angeles lakers",
  "los angeles c": "los angeles clippers",
  "oklahoma city": "oklahoma city thunder",
  "okc": "oklahoma city thunder",
  "golden state": "golden state warriors",
  "new york k": "new york knicks",
  "new york n": "new york nets",
  "san antonio": "san antonio spurs",
  "new orleans": "new orleans pelicans",
  "portland": "portland trail blazers",
  // MLB abbreviated city names
  "los angeles d": "los angeles dodgers",
  "los angeles a": "los angeles angels",
  "new york y": "new york yankees",
  "new york m": "new york mets",
  "chicago w": "chicago white sox",
  "chicago c": "chicago cubs",
  // NCAAB subtitle expansions (matches KALSHI_SUBTITLE_ALIAS in ingest)
  "moh": "miami oh",
  "nc st": "nc state",  "nc st.": "nc state",
  "ohio st": "ohio state", "ohio st.": "ohio state",
  "colorado st": "colorado state", "colorado st.": "colorado state",
  "san diego st": "san diego state", "san diego st.": "san diego state",
  "michigan st": "michigan state", "michigan st.": "michigan state",
  "iowa st": "iowa state",  "iowa st.": "iowa state",
  "kansas st": "kansas state", "kansas st.": "kansas state",
  "utah st": "utah state",  "utah st.": "utah state",
  "unlv": "unlv",
  "unt": "north texas",
  "uconn": "connecticut",  "conn": "connecticut",
  "sju": "st johns",
  "txam": "texas am",
  // Hyphenated NCAAB names (after hyphen→space normalization)
  "arkansas pine bluff": "arkansas pine bluff",
  "arpb": "arkansas pine bluff",
  "ut arlington": "ut arlington",
  "utah tech": "utah tech",
  "southern utah": "southern utah",
};

function normalizeTeamName(raw: string): string {
  let s = raw.toLowerCase().trim().replace(/-/g, " ").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s+(fc|sc|cf|ac|afc|fk|nk|bk|rfc)$/, "");
  return KALSHI_TEAM_ABBREV[s] ?? TEAM_ALIAS[s] ?? s;
}

/** Strip mascot from full TR team name (e.g. "Ohio State Buckeyes" → "ohio state") */
function trSchoolName(fullName: string): string {
  const words = fullName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/);
  return words.length > 1 ? words.slice(0, -1).join(" ") : words[0];
}

/**
 * Read all latest-odds-api*.json files and build a map of
 * lowercase team name → devigged win probability (home+away, 2-way normalized).
 */
function buildBooksMap(): Map<string, number> {
  const result = new Map<string, number>();
  const newStartTime = new Map<string, number>();
  let files: string[];
  try {
    files = fs.readdirSync(ODDS_DATA_DIR)
      .filter(f => f.startsWith("latest-odds-api") && f.endsWith(".json"));
  } catch { return result; }

  for (const file of files) {
    try {
      const raw   = JSON.parse(fs.readFileSync(path.join(ODDS_DATA_DIR, file), "utf8")) as OddsApiFile | OddsApiGame[];
      const games = Array.isArray(raw) ? raw : (raw as OddsApiFile).events ?? [];

      for (const game of games) {
        const homeRaws: number[] = [];
        const awayRaws: number[] = [];

        for (const bm of game.bookmakers ?? []) {
          const h2h = bm.markets?.find(m => m.key === "h2h");
          if (!h2h) continue;
          for (const outcome of h2h.outcomes ?? []) {
            if (outcome.price <= 0) continue;
            const raw = 1 / outcome.price; // decimal odds → implied prob
            if (outcome.name === game.home_team)       homeRaws.push(raw);
            else if (outcome.name === game.away_team)  awayRaws.push(raw);
            // draw outcomes intentionally excluded from 2-way devig
          }
        }

        if (homeRaws.length === 0 && awayRaws.length === 0) continue;

        const avg = (arr: number[]) =>
          arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
        const homeAvg = avg(homeRaws);
        const awayAvg = avg(awayRaws);
        const total   = homeAvg + awayAvg;
        if (total <= 0) continue;

        // Devig: normalize home+away to sum to 1
        const hA = homeAvg / total;
        const aA = awayAvg / total;
        result.set(game.home_team.toLowerCase(), hA);
        result.set(normalizeTeamName(game.home_team), hA);
        result.set(game.away_team.toLowerCase(), aA);
        result.set(normalizeTeamName(game.away_team), aA);

        // Populate start times
        if (game.commence_time) {
          const startMs = new Date(game.commence_time).getTime();
          if (Number.isFinite(startMs)) {
            for (const key of [
              game.home_team.toLowerCase(), normalizeTeamName(game.home_team),
              game.away_team.toLowerCase(), normalizeTeamName(game.away_team),
            ]) {
              newStartTime.set(key, startMs);
            }
          }
        }
      }
    } catch { /* bad file — skip */ }
  }

  booksStartTime = newStartTime;
  return result;
}

/**
 * Extract the YES-side team name.
 * Priority: subtitle (explicit, e.g. "Detroit") → "Will X win" → "X at Y Winner?" → "X vs Y Winner?"
 */
function parseYesTeam(title: string, subtitle?: string): string | null {
  if (subtitle?.trim()) return subtitle.trim();
  const m1 = title.match(/will\s+(?:the\s+)?(.+?)\s+win/i);
  if (m1) return m1[1].trim();
  const m2 = title.match(/^(?:the\s+)?(.+?)\s+(?:at|vs\.?)\s+/i);
  if (m2) return m2[1].trim();
  return null;
}

/** Fuzzy-match a team name against the books map. */
function fuzzyLookupProb(team: string, map: Map<string, number>): number | null {
  const t = team.toLowerCase();
  const tNorm = normalizeTeamName(team);
  const tSchool = trSchoolName(tNorm.length > 2 ? tNorm : t);

  if (map.has(t)) return map.get(t)!;
  if (map.has(tNorm)) return map.get(tNorm)!;
  if (tSchool.length > 2 && map.has(tSchool)) return map.get(tSchool)!;

  const teamWords = t.split(" ");
  const lastWord  = teamWords[teamWords.length - 1];

  for (const [key, val] of map) {
    if (key === tNorm || key.includes(tNorm) || tNorm.includes(key)) return val;
    if (key.includes(t) || t.includes(key)) return val;
    const keyWords = key.split(" ");
    if (keyWords[keyWords.length - 1] === lastWord) return val;
  }

  return null;
}

/**
 * Re-read odds API files (at most every ODDS_REFRESH_INTERVAL_MS),
 * rebuild devigged probability map, and push updated booksMid to all markets.
 */
function refreshBooksOdds(): void {
  const now = Date.now();
  if (now - lastBooksTs < ODDS_REFRESH_INTERVAL_MS) return;
  lastBooksTs = now;

  const newMap = buildBooksMap();
  if (newMap.size === 0) {
    warn("Books map empty — no odds API files found in", ODDS_DATA_DIR);
    return;
  }
  booksMap = newMap;

  // Check odds file freshness — reject if all files are stale
  const ODDS_MAX_AGE_MS = 20 * 60 * 1000; // 20 minutes
  let newestFileMtime = 0;
  try {
    for (const f of fs.readdirSync(ODDS_DATA_DIR).filter(f => f.startsWith("latest-odds-api") && f.endsWith(".json"))) {
      const mtime = fs.statSync(path.join(ODDS_DATA_DIR, f)).mtimeMs;
      if (mtime > newestFileMtime) newestFileMtime = mtime;
    }
  } catch { /* ignore */ }
  if (newestFileMtime > 0 && Date.now() - newestFileMtime > ODDS_MAX_AGE_MS) {
    warn(`Odds data is stale (${Math.round((Date.now() - newestFileMtime) / 60000)}m old) — skipping books update`);
    return;
  }

  let updated = 0;
  for (const ms of markets.values()) {
    const yesTeam = parseYesTeam(ms.title, ms.subtitle);
    if (!yesTeam) {
      // No team name parseable — can't match books, clear stale booksMid
      if (ms.booksMid > 0) { ms.booksMid = 0; ms.priceHistory = []; }
      continue;
    }
    const prob = fuzzyLookupProb(yesTeam, booksMap);

    if (prob === null) {
      // Team not in current odds feed — game likely started or removed.
      // Reset booksMid so we don't trade on a stale pre-game line.
      if (ms.booksMid > 0) {
        ms.booksMid = 0;
        ms.priceHistory = []; // clear history so leader detection starts fresh if game returns
        updated++;
      }
      continue;
    }

    const prev = ms.booksMid;
    if (Math.abs(prob - prev) > 0.001) {
      ms.booksMid = prob;
      // Record books tick into price history immediately on every meaningful move
      if (ms.kalshiMid > 0) {
        ms.priceHistory.push({ ts: Date.now(), booksMid: prob, kalshiMid: ms.kalshiMid });
        if (ms.priceHistory.length > PRICE_HISTORY_MAX) ms.priceHistory.shift();
      }
      // Trigger a signal check if the books price moved and Kalshi is live
      if (prev > 0 && ms.receivedKalshiSnapshot) {
        checkSignal(ms.ticker);
      }
      updated++;
    }
  }

  log(`Books: ${newMap.size} teams | ${updated} markets updated`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TheRundown — REST snapshot + WebSocket live feed
// ─────────────────────────────────────────────────────────────────────────────

/** Convert American odds to raw implied probability (no devig). */
function americanToImplied(american: string | number): number {
  const n = typeof american === "string" ? parseFloat(american) : american;
  if (!Number.isFinite(n) || n === 0) return 0;
  if (n > 0) return 100 / (n + 100);
  return Math.abs(n) / (Math.abs(n) + 100);
}

/**
 * Given home+away raw implied probs, return the devigged home win probability.
 * Returns null if either side is missing or invalid.
 */
function devig(homeImplied: number, awayImplied: number): number | null {
  const total = homeImplied + awayImplied;
  if (total <= 0) return null;
  return homeImplied / total;
}

/**
 * Push a fresh devigged probability into booksMap and trigger signal checks
 * for all Kalshi markets that match this team.
 */
function pushBooksProbToMarkets(homeTeam: string, awayTeam: string, homeProb: number, commenceTimeMs: number, isLiveTick = false): void {
  const awayProb = 1 - homeProb;

  // Update booksMap entries — include school-name-only key (strips mascot) for NCAAB matching
  const homeKeys = [...new Set([homeTeam.toLowerCase(), normalizeTeamName(homeTeam), trSchoolName(homeTeam)])];
  const awayKeys = [...new Set([awayTeam.toLowerCase(), normalizeTeamName(awayTeam), trSchoolName(awayTeam)])];
  for (const k of homeKeys) booksMap.set(k, homeProb);
  for (const k of awayKeys) booksMap.set(k, awayProb);

  // Update game start times
  const startKeys = [...homeKeys, ...awayKeys];
  for (const k of startKeys) booksStartTime.set(k, commenceTimeMs);

  // Build a mini-map for this game only (home + away) so fuzzyLookupProb can do
  // partial/city-name matching (e.g. "New York" → "New York Knicks" → homeProb)
  const gameMap = new Map<string, number>();
  for (const k of homeKeys) gameMap.set(k, homeProb);
  for (const k of awayKeys) gameMap.set(k, awayProb);

  // Push to any matching Kalshi markets and trigger signal check
  for (const ms of markets.values()) {
    const yesTeam = parseYesTeam(ms.title, ms.subtitle);
    if (!yesTeam) continue;

    const prob = fuzzyLookupProb(yesTeam, gameMap);
    if (prob === null) continue;

    // Date guard: only accept TR events that fall on the same ET calendar date
    // as the Kalshi market's ticker date (e.g. 26MAR13 → 2026-03-13).
    // This prevents yesterday's finished games (e.g. 9 PM ET = 2 AM UTC next day)
    // from matching today's Kalshi markets and producing phantom game-age blocks.
    if (commenceTimeMs > 0) {
      const mktDate = parseDateFromTicker(ms.ticker);
      const evDate  = toEtDateStr(commenceTimeMs);
      if (mktDate && evDate !== mktDate) continue; // wrong ET day — skip
      ms.commenceTimeMs = commenceTimeMs;
    }

    // Count live Pinnacle ticks so checkSignal can require stabilization
    if (isLiveTick) ms.liveTicksSeen++;

    const prev = ms.booksMid;
    if (Math.abs(prob - prev) > 0.001) {
      ms.booksMid = prob;
      if (ms.kalshiMid > 0) {
        ms.priceHistory.push({ ts: Date.now(), booksMid: prob, kalshiMid: ms.kalshiMid });
        if (ms.priceHistory.length > PRICE_HISTORY_MAX) ms.priceHistory.shift();
      }
      if (ms.receivedKalshiSnapshot) checkSignal(ms.ticker);
    }
  }
}

/**
 * Fetch today's events for all sports from TheRundown REST API.
 * Builds eventMap (event_id → metadata) and primes booksMap with current
 * Pinnacle moneylines.
 */
async function loadTodayEvents(): Promise<void> {
  const apiKey = process.env.THERUNDOWN_API_KEY;
  if (!apiKey) {
    warn("THERUNDOWN_API_KEY not set — skipping TheRundown event load");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  let loaded = 0;
  let primed = 0;

  for (const sportId of TR_SPORT_IDS) {
    // Stagger requests to avoid 429s — soccer sports (16, 33) are particularly rate-limited
    if (loaded > 0) await new Promise(r => setTimeout(r, 150));
    try {
      const url = `${TR_API_BASE}/sports/${sportId}/events/${today}?market_ids=1,41&affiliate_ids=${TR_AFFILIATE_ID}&include=all_periods`;
      let resp = await fetch(url, {
        headers: { "X-Therundown-Key": apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status === 429) {
        warn(`TR REST sport ${sportId}: 429, retrying after 3s`);
        await new Promise(r => setTimeout(r, 3_000));
        resp = await fetch(url, {
          headers: { "X-Therundown-Key": apiKey },
          signal: AbortSignal.timeout(15_000),
        });
      }
      if (!resp.ok) {
        warn(`TR REST sport ${sportId}: HTTP ${resp.status}`);
        continue;
      }

      const body = await resp.json() as { events?: TRRestEvent[] };
      const events = body.events ?? [];

      for (const ev of events) {
        // Find prematch (1) and live (41) moneyline markets
        const mlPre  = ev.markets?.find(m => m.market_id === 1);
        const mlLive = ev.markets?.find(m => m.market_id === 41);
        if (!mlPre && !mlLive) continue;

        // Use prematch market for team names/IDs if available, else live
        const mlRef = mlPre ?? mlLive!;
        const parts = mlRef.participants;
        if (parts.length < 2) continue;

        // Infer home/away from teams array when possible
        const teamsArr = ev.teams ?? [];
        const homeTeamEntry = teamsArr.find(t => t.is_home === true);
        const awayTeamEntry = teamsArr.find(t => t.is_home === false);

        let homeP: TRRestParticipant;
        let awayP: TRRestParticipant;
        if (homeTeamEntry && awayTeamEntry) {
          homeP = parts.find(p => p.name === homeTeamEntry.name) ?? parts[0];
          awayP = parts.find(p => p.name === awayTeamEntry.name) ?? parts[1];
        } else {
          [homeP, awayP] = parts;
        }

        // Get live market participant IDs (different numbering from prematch)
        let liveHomeId = 0;
        let liveAwayId = 0;
        if (mlLive && mlLive.participants.length >= 2) {
          const liveParts = mlLive.participants;
          // Match by name to get the right live participant IDs
          const liveHomeP = liveParts.find(p => p.name === homeP.name) ?? liveParts[0];
          const liveAwayP = liveParts.find(p => p.name === awayP.name) ?? liveParts[1];
          liveHomeId = liveHomeP.id;
          liveAwayId = liveAwayP.id;
        }

        const homePrice = homeP.lines?.[0]?.prices?.[String(TR_AFFILIATE_ID)]?.price;
        const awayPrice = awayP.lines?.[0]?.prices?.[String(TR_AFFILIATE_ID)]?.price;

        // Also try live prices if prematch not available
        const liveHomePrice = mlLive?.participants.find(p => p.id === liveHomeId)?.lines?.[0]?.prices?.[String(TR_AFFILIATE_ID)]?.price;
        const liveAwayPrice = mlLive?.participants.find(p => p.id === liveAwayId)?.lines?.[0]?.prices?.[String(TR_AFFILIATE_ID)]?.price;

        const effectiveHomePrice = homePrice ?? liveHomePrice;
        const effectiveAwayPrice = awayPrice ?? liveAwayPrice;

        // Build event map
        const commenceTimeMs = ev.event_date ? new Date(ev.event_date).getTime() : 0;
        eventMap.set(ev.event_id, {
          homeTeam:             homeP.name,
          awayTeam:             awayP.name,
          homeParticipantId:    homeP.id,
          awayParticipantId:    awayP.id,
          liveHomeParticipantId: liveHomeId,
          liveAwayParticipantId: liveAwayId,
          commenceTimeMs,
          sportId:              ev.sport_id,
        });
        loaded++;

        // Prime pinnacleRaw and booksMap if both prices available
        if (effectiveHomePrice != null && effectiveAwayPrice != null) {
          const homeImpl = americanToImplied(effectiveHomePrice);
          const awayImpl = americanToImplied(effectiveAwayPrice);

          const raw = new Map<number, number>();
          raw.set(homeP.id, homeImpl);
          raw.set(awayP.id, awayImpl);
          pinnacleRaw.set(ev.event_id, raw);

          const homeDevig = devig(homeImpl, awayImpl);
          if (homeDevig !== null) {
            pushBooksProbToMarkets(homeP.name, awayP.name, homeDevig, commenceTimeMs);
            primed++;
          }
        }
      }
    } catch (err) {
      warn(`TR REST sport ${sportId} error: ${(err as Error).message}`);
    }
  }

  eventMapLoadedAt = Date.now();
  log(`TR REST: loaded ${loaded} events across ${TR_SPORT_IDS.length} sports | ${primed} primed in booksMap`);
}

let trMsgCount = 0;
let trMatchCount = 0;

/** Handle a single TheRundown market_price WS message. */
function handleTheRundownMsg(msg: TRPriceMsg): void {
  if (msg.meta.type === "heartbeat") return;
  if (msg.meta.type !== "market_price") return;

  const d = msg.data;
  if (!d) return;
  trMsgCount++;

  if (d.affiliate_id !== TR_AFFILIATE_ID) return;
  if (d.market_id !== 1 && d.market_id !== 41) return; // prematch or live moneyline

  // Debug: log first few messages to verify participant ID mapping
  if (trMsgCount <= 5) {
    log(`TR msg #${trMsgCount}: event=${d.event_id.slice(0,8)} mkt=${d.market_id} aff=${d.affiliate_id} participant=${d.market_participant_id} price=${d.price}`);
  }
  if (d.is_main_line === false) return; // skip alt lines

  const ev = eventMap.get(d.event_id);
  if (!ev) return; // unknown event — may be outside our sports

  const pid        = d.market_participant_id;
  const newImplied = americanToImplied(d.price);
  if (newImplied <= 0) return;

  // Check known participant IDs (prematch or previously-learned live)
  const isHome = pid === ev.homeParticipantId || (ev.liveHomeParticipantId > 0 && pid === ev.liveHomeParticipantId);
  const isAway = pid === ev.awayParticipantId || (ev.liveAwayParticipantId > 0 && pid === ev.liveAwayParticipantId);

  if (!isHome && !isAway && d.market_id === 41) {
    // Unknown live participant — accumulate until we have both sides, then resolve
    let acc = liveAccum.get(d.event_id);
    if (!acc) { acc = new Map(); liveAccum.set(d.event_id, acc); }
    acc.set(pid, newImplied);

    if (acc.size >= 2) {
      // We have both live participants — figure out home vs away by comparing
      // each implied prob to the pre-game booksMap probability for homeTeam
      const entries = [...acc.entries()]; // [[pidA, implA], [pidB, implB]]
      const preHomeProb = fuzzyLookupProb(ev.homeTeam, booksMap) ?? 0.5;
      const [pidA, implA] = entries[0];
      const [pidB, implB] = entries[1];
      const totalAB = implA + implB;

      // The one closer to pre-game home probability is the home team
      const homeIsA = Math.abs(implA / totalAB - preHomeProb) <= Math.abs(implB / totalAB - preHomeProb);
      const resolvedHomeId = homeIsA ? pidA : pidB;
      const resolvedAwayId = homeIsA ? pidB : pidA;

      // Save back to eventMap so future messages resolve instantly
      ev.liveHomeParticipantId = resolvedHomeId;
      ev.liveAwayParticipantId = resolvedAwayId;
      log(`TR live IDs learned: ${ev.homeTeam} home=${resolvedHomeId} away=${resolvedAwayId}`);

      // Now process both accumulated entries
      const accHomeImpl = homeIsA ? implA : implB;
      const accAwayImpl = homeIsA ? implB : implA;
      const accTotal    = accHomeImpl + accAwayImpl;
      if (accTotal > 0) {
        const homeDevig = accHomeImpl / accTotal;
        trMatchCount++;
        pushBooksProbToMarkets(ev.homeTeam, ev.awayTeam, homeDevig, ev.commenceTimeMs, true);
      }
      liveAccum.delete(d.event_id);
    }
    return;
  }

  if (!isHome && !isAway) return;

  // Normalize to synthetic keys: 0=home, 1=away
  let raw = pinnacleRaw.get(d.event_id);
  if (!raw) { raw = new Map<number, number>(); pinnacleRaw.set(d.event_id, raw); }
  raw.set(isHome ? 0 : 1, newImplied);

  // Compute devig only when we have both sides
  const homeImpl = raw.get(0);
  const awayImpl = raw.get(1);
  if (homeImpl === undefined || awayImpl === undefined) return;

  const homeDevig = devig(homeImpl, awayImpl);
  if (homeDevig === null) return;

  trMatchCount++;
  pushBooksProbToMarkets(ev.homeTeam, ev.awayTeam, homeDevig, ev.commenceTimeMs, d.market_id === 41);
}

/** Connect to TheRundown WS and stream Pinnacle moneyline deltas. */
function connectTheRundownWs(): void {
  const apiKey = process.env.THERUNDOWN_API_KEY;
  if (!apiKey) {
    warn("THERUNDOWN_API_KEY not set — TheRundown WS disabled");
    return;
  }

  const url = `${TR_WS_URL}?key=${apiKey}&affiliate_ids=${TR_AFFILIATE_ID}&market_ids=${TR_MARKET_IDS}`;
  log("Connecting TheRundown WS (Pinnacle moneyline)...");

  const ws = new WebSocket(url);
  therundownWs = ws;

  ws.on("open", () => {
    log("TheRundown WS open — streaming Pinnacle moneylines live");
    trConnected = true;
    trReconnectDelay = WS_RECONNECT_INITIAL_MS;
  });

  ws.on("message", (data: Buffer) => {
    let msg: TRPriceMsg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handleTheRundownMsg(msg);
  });

  ws.on("error", (err) => warn(`TheRundown WS error: ${err.message}`));

  ws.on("close", () => {
    trConnected    = false;
    therundownWs   = null;
    if (!running) return;
    log(`TheRundown WS closed — reconnect in ${trReconnectDelay / 1000}s`);
    setTimeout(() => {
      if (running) connectTheRundownWs();
      trReconnectDelay = Math.min(trReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    }, trReconnectDelay);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Leader Detection (Granger-style lead-lag — books vs kalshi)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether sportsbooks are leading Kalshi using step-function recency.
 *
 * Because sportsbook odds update every 15s (a step function) while Kalshi
 * ticks continuously, Granger-style lead-lag correlation is degenerate — it
 * always yields composite=0.5 regardless of real signal strength.
 *
 * Instead we detect:
 *   1. Books moved recently (within the last MAX_LAG_TICKS ticks)
 *   2. The move was large enough to be meaningful (≥ MIN_BOOKS_MOVE)
 *   3. Kalshi has NOT already fully caught up in the same direction
 *
 * Confidence = how recently books moved (1.0 = this tick, 0 = too old).
 */
function detectLeader(
  booksPrices:  number[],
  kalshiPrices: number[],
  lookback = 8,
): LeaderDetectionResult {
  const EMPTY: LeaderDetectionResult = {
    leader: "UNKNOWN", confidence: 0, direction: "FLAT",
    magnitude: 0, momentumConfirmed: false, momentumStrength: 0,
  };

  const minLen = Math.max(4, lookback);
  if (booksPrices.length < minLen || kalshiPrices.length < minLen) return EMPTY;

  const booksW  = booksPrices.slice(-lookback);
  const kalshiW = kalshiPrices.slice(-lookback);

  // ── Step 1: find the most recent books price step ──────────────────────────
  const MIN_BOOKS_MOVE  = 0.005;  // 0.5pp minimum books step to count
  const MAX_LAG_TICKS   = Math.max(3, Math.floor(lookback * 0.5)); // books must have moved within this many ticks

  let lastChangeIdx = -1;
  let lastChangeDelta = 0;
  for (let i = booksW.length - 1; i > 0; i--) {
    const delta = booksW[i] - booksW[i - 1];
    if (Math.abs(delta) >= MIN_BOOKS_MOVE) {
      lastChangeIdx  = i;
      lastChangeDelta = delta;
      break;
    }
  }

  // No meaningful books move in the window
  if (lastChangeIdx === -1) return EMPTY;

  // Books move is too old — Kalshi has had time to catch up already
  const ticksSinceChange = (booksW.length - 1) - lastChangeIdx;
  if (ticksSinceChange > MAX_LAG_TICKS) return EMPTY;

  // ── Step 2: confirm Kalshi has NOT already caught up ──────────────────────
  const kalshiAtChange  = kalshiW[Math.max(0, lastChangeIdx - 1)];
  const kalshiNow       = kalshiW[kalshiW.length - 1];
  const kalshiMove      = kalshiNow - kalshiAtChange;
  const caughtUpFraction = Math.abs(lastChangeDelta) > 0
    ? (kalshiMove * Math.sign(lastChangeDelta)) / Math.abs(lastChangeDelta)
    : 0;

  // If Kalshi has already moved ≥70% of the books move in the same direction, skip
  if (caughtUpFraction >= 0.70) return EMPTY;

  // ── Step 3: compute confidence and direction ───────────────────────────────
  // Confidence: 1.0 if books just moved this tick, decays linearly with age
  const confidence = 1 - ticksSinceChange / (MAX_LAG_TICKS + 1);
  const magnitude  = Math.abs(lastChangeDelta);
  const direction: "UP" | "DOWN" | "FLAT" = lastChangeDelta > 0 ? "UP" : "DOWN";

  // Momentum: books move is large, or Kalshi is actively lagging (not catching up)
  const momentumConfirmed = magnitude >= 0.01 || caughtUpFraction < 0.2;
  const momentumStrength  = magnitude;

  return {
    leader: "BOOKS",
    confidence,
    direction,
    magnitude,
    momentumConfirmed,
    momentumStrength,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kelly Sizing (Kalshi-fee-aware, same as polling version)
// ─────────────────────────────────────────────────────────────────────────────

function computeKellySize(
  edgePct: number,
  leaderConfidence: number,
  priceCents: number,
  isPregame = false,
): { contracts: number; costUsd: number } {
  const edge    = edgePct / 100;
  const winProb = Math.min(0.75, Math.max(0.35, 0.50 + edge * leaderConfidence * 2));
  const losProb = 1 - winProb;

  const grossPerDollar = edge > 0 ? (1 - edge) / edge : 0;
  const netPerDollar   = grossPerDollar * 0.93; // 7% Kalshi fee
  if (netPerDollar <= 0) return { contracts: 0, costUsd: 0 };

  const kelly     = winProb - losProb / netPerDollar;
  const halfKelly = Math.max(0, Math.min(0.25, kelly * 0.5));

  const rawCost    = halfKelly * 50;
  const baseCost   = edgePct >= HIGH_EDGE_THRESHOLD_PCT ? HIGH_EDGE_COST_USD : DEFAULT_COST_USD;
  // Pregame: size up 1.5× — deeper books, cleaner exits, structural edge is higher confidence
  const targetCost = isPregame ? baseCost * 1.5 : baseCost;
  const maxCost    = isPregame ? PREGAME_MAX_COST_USD : MAX_COST_PER_ORDER_USD;
  const clampedCost = Math.min(maxCost, Math.max(0.50, Math.min(rawCost, targetCost)));

  // contracts = how many YES (or NO) shares to buy at priceCents
  const priceUsd   = priceCents / 100;
  const contracts  = Math.max(1, Math.round(clampedCost / priceUsd));
  const actualCost = contracts * priceUsd;
  return { contracts, costUsd: actualCost };
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety Caps
// ─────────────────────────────────────────────────────────────────────────────

interface CapResult { canTrade: boolean; reasons: string[]; }

function checkCaps(ticker: string): CapResult {
  const reasons: string[] = [];
  const now = Date.now();

  state.ordersInLastHour = state.ordersInLastHour.filter(
    ts => now - new Date(ts).getTime() < 3_600_000,
  );

  const openPos = Object.keys(state.openPositions).length;
  const resting = Object.keys(state.pendingEntries).length;
  const perHour = state.ordersInLastHour.length;

  let totalExposure = 0;
  for (const p of Object.values(state.openPositions)) totalExposure += p.costUsd;
  for (const p of Object.values(state.pendingEntries)) totalExposure += p.costUsd;

  if (openPos  >= MAX_OPEN_POSITIONS)    reasons.push(`positions=${openPos}`);
  if (resting  >= MAX_RESTING_ORDERS)    reasons.push(`resting=${resting}`);
  if (perHour  >= MAX_ORDERS_PER_HOUR)   reasons.push(`orders/hr=${perHour}`);
  if (totalExposure >= MAX_TOTAL_EXPOSURE_USD) reasons.push(`exposure=$${totalExposure.toFixed(2)}`);

  const evKey = wsGameKey(ticker);
  const eventExposure =
    Object.values(state.openPositions).filter(p => wsGameKey(p.ticker) === evKey).reduce((s, p) => s + p.costUsd, 0) +
    Object.values(state.pendingEntries).filter(p => wsGameKey(p.ticker) === evKey).reduce((s, p) => s + p.costUsd, 0);
  if (eventExposure >= MAX_EVENT_EXPOSURE_USD) reasons.push(`event-exposure=$${eventExposure.toFixed(2)}`);

  const mktPnl = state.marketCumulativePnl[ticker] ?? 0;
  if (mktPnl <= MARKET_LOSS_LIMIT_USD) reasons.push(`mkt-loss=$${mktPnl.toFixed(2)}`);

  const cooldown = state.entryCooldowns[wsGameKey(ticker)] ?? 0;
  if (now < cooldown) reasons.push(`cooldown=${Math.ceil((cooldown - now) / 1000)}s`);

  return { canTrade: reasons.length === 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal Check — fires on every Kalshi price update (debounced per market)
// ─────────────────────────────────────────────────────────────────────────────

function checkSignal(ticker: string): void {
  if (!running || isKillSwitchSet()) return;

  const ms = markets.get(ticker);
  if (!ms || !ms.receivedKalshiSnapshot) return;

  const now = Date.now();
  if (now - ms.lastSignalCheck < SIGNAL_DEBOUNCE_MS) return;
  ms.lastSignalCheck = now;

  // Need a valid books price
  if (ms.booksMid <= 0 || ms.kalshiMid <= 0) return;

  // Pre-game cutoff: skip only in the final 5 min before tip (Kalshi cancels at tip anyway)
  const PREGAME_CUTOFF_MS = 5 * 60 * 1000;
  const yesTeamRaw = parseYesTeam(ms.title, ms.subtitle);
  if (yesTeamRaw) {
    const startTs = booksStartTime.get(yesTeamRaw.toLowerCase())
                 ?? booksStartTime.get(normalizeTeamName(yesTeamRaw));
    // Only block in the 5-min window before tip — allow both pregame and live
    if (startTs && Date.now() > startTs - PREGAME_CUTOFF_MS && Date.now() < startTs + 60_000) return;
  }

  if (ms.priceHistory.length < 2) return;

  // Per-market in-process lock — blocks re-entry while an order is in flight
  if (ms.signalFired) return;

  // Skip if already in or entering ANY market from the same game (event-level dedup)
  const evKey = wsGameKey(ticker);
  const inPosition = Object.values(state.openPositions).some(p => wsGameKey(p.ticker) === evKey);
  const inEntry    = Object.values(state.pendingEntries).some(p => wsGameKey(p.ticker) === evKey);
  if (inPosition || inEntry) return;

  // Hard lock — never re-enter a game already played this session
  if (state.playedGames[evKey]) {
    return;
  }

  // In-memory lock — blocks concurrent evaluation of the same game from two rapid ticks
  if (pendingGameEntry.has(evKey)) return;
  pendingGameEntry.add(evKey);

  try {

  // For live games (game already started), require MIN_LIVE_TICKS Pinnacle ticks
  // before trusting a signal. The first few ticks after IDs are learned are often
  // unstabilized — Pinnacle's live engine takes several updates to settle.
  const isLiveGame = ms.commenceTimeMs > 0 && Date.now() > ms.commenceTimeMs;
  if (isLiveGame && ms.liveTicksSeen < MIN_LIVE_TICKS) {
    return; // wait for live Pinnacle price to stabilize
  }

  // Block entries on games that are too old — likely in closing minutes
  if (ms.commenceTimeMs > 0) {
    const sport = sportFromTicker(ticker);
    const maxAge = GAME_MAX_AGE_MS[sport] ?? GAME_MAX_AGE_MS["DEFAULT"];
    const gameAge = Date.now() - ms.commenceTimeMs;
    if (gameAge > maxAge) {
      log(`SKIP ${ticker} game-age: ${Math.round(gameAge / 60_000)}min > ${Math.round(maxAge / 60_000)}min limit`);
      return;
    }
  }

  const booksHistory  = ms.priceHistory.map(h => h.booksMid);
  const kalshiHistory = ms.priceHistory.map(h => h.kalshiMid);

  const leader = detectLeader(booksHistory, kalshiHistory, Math.min(8, booksHistory.length - 1));

  // ── Pregame context ───────────────────────────────────────────────────────
  const gameStartTs = booksStartTime.get(yesTeamRaw?.toLowerCase() ?? "")
                   ?? booksStartTime.get(normalizeTeamName(yesTeamRaw ?? ""))
                   ?? 0;
  const msNow    = Date.now();
  const isPregame = gameStartTs > 0 && msNow < gameStartTs;

  // Block pregame entries when game is more than 30 min away — edge won't close until tip
  if (isPregame && gameStartTs - msNow > PREGAME_MAX_AHEAD_MS) {
    return;
  }

  // ── Gap persistence: how many of the last N ticks showed gap in same direction ≥2pp
  const rawEdge = (ms.booksMid - ms.kalshiMid) * 100;
  const gapHistory     = ms.priceHistory.map(h => h.booksMid - h.kalshiMid);
  const consistentTicks = gapHistory.filter(g => rawEdge > 0 ? g > 0.02 : g < -0.02).length;
  const isLongLivedGap  = isPregame
    && ms.priceHistory.length >= 15
    && consistentTicks >= Math.floor(ms.priceHistory.length * 0.6);

  // ── CrossEdge pre-filter: ingest Pinnacle already flagged this market ──────
  // hasCrossEdge = Pinnacle gap ≥5% at ingest time AND we're still pregame
  const hasCrossEdge = ms.crossEdgeGapPct >= 5 && isPregame;

  // ── Effective thresholds (relaxed when structural evidence exists) ─────────
  //   hasCrossEdge:  edge threshold 5%, confidence 0.35, no momentum required
  //   isLongLivedGap: confidence 0.40, no momentum required
  //   standard:      edge threshold 8%, confidence 0.50, momentum required
  const effectiveEdgeThreshold = hasCrossEdge ? Math.max(5, EDGE_THRESHOLD_PCT - 3) : EDGE_THRESHOLD_PCT;
  const effectiveConfidence    = hasCrossEdge ? 0.35 : isLongLivedGap ? 0.40 : 0.50;
  const needsMomentum          = !hasCrossEdge && !isLongLivedGap;
  const effectiveMagnitude     = hasCrossEdge ? 0.003 : 0.005;

  // Books must lead with appropriate confidence for market context
  if (leader.leader !== "BOOKS")                    return;
  if (leader.confidence < effectiveConfidence)      return;
  if (needsMomentum && !leader.momentumConfirmed)   return;
  if (leader.direction === "FLAT")                  return;
  if (leader.magnitude < effectiveMagnitude)        return;

  // Edge at mid
  const edgePct = leader.direction === "UP" ? rawEdge : -rawEdge;
  if (edgePct < effectiveEdgeThreshold) return;

  // CrossEdge direction guard: don't trade against the ingest signal
  if (hasCrossEdge) {
    const expectedSide: "yes" | "no" = ms.crossEdgeDirection === "model-higher" ? "yes" : "no";
    const currentSide:  "yes" | "no" = rawEdge > 0 ? "yes" : "no";
    if (currentSide !== expectedSide) return;
  }

  // Game-state-aware phantom edge cap
  const phantomCap = gameStartTs === 0         ? 50
                   : isPregame                 ? 50  // pregame
                   : msNow < gameStartTs + 4 * 3_600_000 ? 70  // live window
                   :                             30; // game likely over

  if (Math.abs(rawEdge) > phantomCap) {
    const lastLogged = phantomEdgeLoggedAt.get(ticker) ?? 0;
    if (msNow - lastLogged > 300_000) {
      log(`SKIP ${ticker} phantom edge: books=${(ms.booksMid * 100).toFixed(1)}c kalshi=${(ms.kalshiMid * 100).toFixed(1)}c gap=${rawEdge.toFixed(1)}pp cap=${phantomCap}pp`);
      phantomEdgeLoggedAt.set(ticker, msNow);
    }
    return;
  }

  const caps = checkCaps(ticker);
  if (!caps.canTrade) {
    log(`SKIP ${ticker} caps: ${caps.reasons.join(", ")}`);
    return;
  }

  // Determine side and actual fill price (market order fills at ask)
  const side: "yes" | "no" = rawEdge > 0 ? "yes" : "no";

  const entryPriceCents = side === "yes"
    ? Math.round(ms.kalshiYesAsk * 100)
    : Math.round((1 - ms.kalshiYesBid) * 100);

  if (entryPriceCents <= 0 || entryPriceCents >= 100) return;

  // Net edge at actual fill price — spread eats into edge
  const fillFrac   = entryPriceCents / 100;
  const netEdgePct = side === "yes"
    ? (ms.booksMid - fillFrac) * 100
    : ((1 - ms.booksMid) - fillFrac) * 100;

  if (netEdgePct < effectiveEdgeThreshold) return;

  const contextTag = hasCrossEdge     ? "[CE+PREGAME]"
                   : isLongLivedGap  ? "[LONGGAP+PREGAME]"
                   : isPregame       ? "[PREGAME]"
                   :                   "[LIVE]";
  log(`SIGNAL ${contextTag} ${ticker} ${side.toUpperCase()} @${entryPriceCents}c midEdge=${edgePct.toFixed(1)}% netEdge=${netEdgePct.toFixed(1)}% leader=${leader.leader}(${(leader.confidence * 100).toFixed(0)}%) momentum=${leader.momentumStrength.toFixed(4)}`);

  // Lock this market and the whole game immediately — prevents both same-market
  // re-entry (ms.signalFired) and opposite-side entry (state.playedGames).
  ms.signalFired = true;
  state.playedGames[wsGameKey(ticker)] = true;
  // Also mark every other market in the same game as fired — closes the gap where
  // the opposite side could still fire if this market's pendingGameEntry was released.
  for (const other of markets.values()) {
    if (other.ticker !== ticker && wsGameKey(other.ticker) === evKey) {
      other.signalFired = true;
    }
  }
  saveState();

  placeEntry(ms, side, entryPriceCents, netEdgePct, leader, isPregame)
    .catch(e => warn(`placeEntry error on ${ticker}: ${(e as Error).message}`));

  } finally {
    // Release in-memory lock only if signal didn't fire — if it fired, ms.signalFired
    // stays true and pendingGameEntry entry is left (game is permanently locked via playedGames).
    if (!ms.signalFired) pendingGameEntry.delete(evKey);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order Placement
// ─────────────────────────────────────────────────────────────────────────────

async function placeEntry(
  ms: MarketState,
  side: "yes" | "no",
  priceCents: number,
  edgePct: number,
  leader: LeaderDetectionResult,
  isPregame = false,
): Promise<void> {
  const { ticker } = ms;
  if (placingTickers.has(ticker)) return;
  placingTickers.add(ticker);

  try {
    const dedupeKey = `${ticker}-${side}-${priceCents}`;
    if (Object.values(state.pendingEntries).some(e => e.dedupeKey === dedupeKey)) return;

    const { contracts, costUsd } = computeKellySize(edgePct, leader.confidence, priceCents, isPregame);
    if (contracts === 0) return;

    const clientOrderId = uuidv4();

    if (DRY_RUN) {
      // Paper trade: skip real order, immediately "fill" at entry price
      const modeTag  = isPregame ? "PREGAME" : "LIVE";
      const paperMsg = `📄 **PAPER ENTRY** [${modeTag}] \`${ticker}\` ${side.toUpperCase()} @${priceCents}c | edge=${edgePct.toFixed(1)}% | ${leader.leader}(${(leader.confidence * 100).toFixed(0)}%) | $${costUsd.toFixed(2)}`;
      log(paperMsg);
      notifyDiscord(paperMsg);
      appendTrade({ type: "paper_entry", ticker, side, priceCents, contracts, costUsd, edgePct, leader: leader.leader });

      // Add directly to openPositions (already filled)
      state.openPositions[clientOrderId] = {
        ticker,
        side,
        entryPriceCents: priceCents,
        countFp: String(contracts),
        costUsd,
        entryOrderId: `paper-${clientOrderId}`,
        entryFillTs:  new Date().toISOString(),
        exitAttempts: 0,
        status:       "awaiting_exit",
        leaderAtEntry:    leader.leader,
        directionAtEntry: leader.direction,
        peakUnrealizedCents: 0,
      };
      state.ordersInLastHour.push(new Date().toISOString());
      state.lastTradeIso = new Date().toISOString();
      saveState();
      return;
    }

    // Limit order at current price — acts as taker since we're crossing the spread
    const priceDollars = (priceCents / 100).toFixed(2);
    const order = await createOrder({
      ticker,
      side,
      action: "buy",
      type: "limit",
      ...(side === "yes"
        ? { yes_price_dollars: priceDollars }
        : { no_price_dollars: priceDollars }),
      count_fp: String(contracts),
      client_order_id: clientOrderId,
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
    state.entryCooldowns[wsGameKey(ticker)] = Date.now() + ENTRY_COOLDOWN_MS;
    state.playedGames[wsGameKey(ticker)] = true;  // lock out this game for the rest of the session
    saveState();

    const modeTag = isPregame ? "PREGAME" : "LIVE";
    const msg = `**WS ENTRY** [${modeTag}] \`${ticker}\` ${side.toUpperCase()} @${priceCents}c | edge=${edgePct.toFixed(1)}% | ${leader.leader}(${(leader.confidence * 100).toFixed(0)}%) | $${costUsd.toFixed(2)}`;
    log(msg);
    notifyDiscord(msg);
    appendTrade({ type: "entry_placed", ticker, side, priceCents, contracts, costUsd, edgePct, leader: leader.leader });
  } catch (err) {
    warn(`createOrder failed: ${(err as Error).message}`);
    state.entryCooldowns[wsGameKey(ticker)] = Date.now() + FAILED_ENTRY_COOLDOWN_MS;
  } finally {
    placingTickers.delete(ticker);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit Management (REST-polled every 30s)
// ─────────────────────────────────────────────────────────────────────────────

async function managePaperExits(): Promise<void> {
  const now = Date.now();
  for (const [posId, pos] of Object.entries(state.openPositions)) {
    if (!pos.entryOrderId.startsWith("paper-")) continue; // only paper positions
    const ms         = markets.get(pos.ticker);
    const currentMid = ms?.kalshiMid ?? 0;
    if (currentMid <= 0) continue;

    const timeSinceEntry = now - new Date(pos.entryFillTs).getTime();
    // For YES: position price = kalshiMid (YES probability)
    // For NO:  position price = 1 - kalshiMid (NO implied price)
    const posMid        = pos.side === "yes" ? currentMid : (1 - currentMid);
    const unrealizedPct = (posMid - pos.entryPriceCents / 100) * 100;

    // Scenario A exits (paper):
    //   TP  — 60% of edge captured
    //   TRAIL — pulled back 35% from peak profit
    //   SL  — position down >8¢
    //   TMO — held 15 min
    const booksMid = ms?.booksMid ?? 0;

    // Update peak
    if (unrealizedPct > (pos.peakUnrealizedCents ?? 0)) pos.peakUnrealizedCents = unrealizedPct;

    const fairPosMid  = pos.side === "yes" ? booksMid : (1 - booksMid);
    const edgeCents   = booksMid > 0 ? (fairPosMid - pos.entryPriceCents / 100) * 100 : 0;
    const hitTP       = edgeCents > 0 && unrealizedPct >= edgeCents * TP_EDGE_CAPTURE_PCT;
    const peak        = pos.peakUnrealizedCents ?? 0;
    const hitTrail    = peak > 2 && unrealizedPct < peak * (1 - TRAILING_STOP_PULLBACK);
    const hitSL  = unrealizedPct <= -SL_CENTS;
    const timedOut = timeSinceEntry > EXIT_TIMEOUT_SEC * 1000;

    if (hitTP || hitTrail || hitSL || timedOut) {
      const reason = hitTP ? "TP(60%edge)" : hitTrail ? "TRAIL(35%pullback)" : hitSL ? "SL(-8¢)" : "TMO(15min)";
      const exitPosMid = pos.side === "yes" ? currentMid : (1 - currentMid);
      // PnL = (exit_price - entry_price) * contracts  [each contract = $1 at settlement]
      const pnl = (exitPosMid - pos.entryPriceCents / 100) * Number(pos.countFp);

      state.realizedPnlUsd += pnl;
      state.marketCumulativePnl[pos.ticker] = (state.marketCumulativePnl[pos.ticker] ?? 0) + pnl;
      if (pnl < 0) state.consecutiveLosses++;
      else state.consecutiveLosses = 0;

      const emoji = pnl >= 0 ? "✅" : "❌";
      const exitDisplayCents = Math.round(exitPosMid * 100);
      const msg = `📄 **PAPER CLOSED** ${emoji} [${reason}] \`${pos.ticker}\` ${pos.side.toUpperCase()} entry=${pos.entryPriceCents}c exit=${exitDisplayCents}c | PnL=$${pnl.toFixed(2)} | Session=$${state.realizedPnlUsd.toFixed(2)}`;
      log(msg);
      notifyDiscord(msg);
      appendTrade({ type: "paper_closed", ticker: pos.ticker, side: pos.side, pnl, entryPriceCents: pos.entryPriceCents, exitPosMid, reason });
      delete state.openPositions[posId];
    }
  }
  saveState();
}

async function fetchWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    warn(`${label} failed, retrying in 2s: ${(e as Error).message}`);
    await new Promise(r => setTimeout(r, 2_000));
    return fn();
  }
}

async function manageExits(): Promise<void> {
  // In dry-run mode, use paper exit logic instead
  if (DRY_RUN) { await managePaperExits(); return; }

  try {
    const [ordersResp, positionsResp] = await Promise.all([
      fetchWithRetry(() => getOrders("resting"), "getOrders"),
      fetchWithRetry(() => getPositions(), "getPositions"),
    ]);
    const apiOrders    = ordersResp    as KalshiOrder[];
    const apiPositions = positionsResp as KalshiPosition[];
    const now = Date.now();

    // — Pending entries: check fills —————————————————————————————————————————
    for (const [clientId, entry] of Object.entries(state.pendingEntries)) {
      const apiOrder = apiOrders.find(o => o.client_order_id === clientId);

      // Check if order filled as a taker (no longer resting — look in positions directly)
      if (!apiOrder || apiOrder.status === "canceled") {
        const apiPos = apiPositions.find(p => (p as any).ticker === entry.ticker);
        const posSize = Number((apiPos as any)?.position_fp ?? 0);
        if (posSize > 0) {
          log(`Entry filled (taker): ${entry.ticker} ${entry.side.toUpperCase()} @${entry.priceCents}c x${posSize}`);
          state.openPositions[clientId] = {
            ticker:          entry.ticker,
            side:            entry.side,
            entryPriceCents: entry.priceCents,
            countFp:         String(posSize),
            costUsd:         entry.costUsd,
            entryOrderId:    clientId,
            entryFillTs:     new Date().toISOString(),
            exitAttempts:    0,
            status:          "awaiting_exit",
            leaderAtEntry:    entry.leaderAtEntry,
            directionAtEntry: entry.directionAtEntry,
            peakUnrealizedCents: 0,
          };
          appendTrade({ type: "entry_filled", ticker: entry.ticker, side: entry.side, priceCents: entry.priceCents, filled: posSize });
        }
        delete state.pendingEntries[clientId];
        continue;
      }

      const filled = Number(apiOrder.count_filled_fp ?? 0);
      if (filled > 0) {
        log(`Entry filled: ${entry.ticker} ${entry.side.toUpperCase()} @${entry.priceCents}c x${filled}`);
        state.openPositions[clientId] = {
          ticker:          entry.ticker,
          side:            entry.side,
          entryPriceCents: entry.priceCents,
          countFp:         String(filled),
          costUsd:         entry.costUsd,
          entryOrderId:    apiOrder.order_id,
          entryFillTs:     new Date().toISOString(),
          exitAttempts:    0,
          status:          "awaiting_exit",
          leaderAtEntry:    entry.leaderAtEntry,
          directionAtEntry: entry.directionAtEntry,
          peakUnrealizedCents: 0,
        };
        delete state.pendingEntries[clientId];
        appendTrade({ type: "entry_filled", ticker: entry.ticker, side: entry.side, priceCents: entry.priceCents, filled });
      }

      if (now - new Date(entry.placedTs).getTime() > ENTRY_TIMEOUT_SEC * 1000) {
        log(`Canceling stale entry: ${entry.ticker}`);
        await cancelOrder(apiOrder.order_id).catch(() => null);
        delete state.pendingEntries[clientId];
      }
    }

    // — Open positions: manage exits ——————————————————————————————————————————
    for (const [posId, pos] of Object.entries(state.openPositions)) {
      const ms         = markets.get(pos.ticker);
      const currentMid = ms?.kalshiMid ?? 0.5;

      const apiPos = apiPositions.find(p => (p as any).ticker === pos.ticker || (p as any).market_id === pos.ticker);
      // position_fp is a string like "28.00" or "0.00" — only treat as closed if API
      // explicitly returns it AND it's zero. If apiPos is missing, keep position open
      // (API may not return positions until after first fill event).
      const apiPosSize = apiPos ? parseFloat((apiPos as any)?.position_fp ?? (apiPos as any)?.position ?? "0") : NaN;
      if (apiPos && apiPosSize === 0) {
        const posMidClose = pos.side === "yes" ? currentMid : (1 - currentMid);
        const pnl = (posMidClose - pos.entryPriceCents / 100) * Number(pos.countFp);

        state.realizedPnlUsd += pnl;
        state.marketCumulativePnl[pos.ticker] = (state.marketCumulativePnl[pos.ticker] ?? 0) + pnl;
        if (pnl < 0) state.consecutiveLosses++;
        else state.consecutiveLosses = 0;

        log(`Closed: ${pos.ticker} PnL=$${pnl.toFixed(2)} | session=$${state.realizedPnlUsd.toFixed(2)}`);
        notifyDiscord(`**WS CLOSED** \`${pos.ticker}\` PnL=$${pnl.toFixed(2)} | Session=$${state.realizedPnlUsd.toFixed(2)}`);
        appendTrade({ type: "position_closed", ticker: pos.ticker, side: pos.side, pnl });
        delete state.openPositions[posId];
        continue;
      }

      const timeSinceEntry = now - new Date(pos.entryFillTs).getTime();
      const posMidLive    = pos.side === "yes" ? currentMid : (1 - currentMid);
      const unrealizedCents = (posMidLive - pos.entryPriceCents / 100) * 100;
      const booksMid = ms?.booksMid ?? 0;

      // Update peak unrealized profit
      if (unrealizedCents > (pos.peakUnrealizedCents ?? 0)) {
        pos.peakUnrealizedCents = unrealizedCents;
      }

      // TP: exit when 60% of edge (entry→fair) is captured
      const fairPosMid = pos.side === "yes" ? booksMid : (1 - booksMid);
      const edgeCents  = booksMid > 0 ? (fairPosMid - pos.entryPriceCents / 100) * 100 : 0;
      const hitTP      = edgeCents > 0 && unrealizedCents >= edgeCents * TP_EDGE_CAPTURE_PCT;

      // Trailing stop: exit if profit pulls back 35% from peak (only if we've been up meaningfully)
      const peak = pos.peakUnrealizedCents ?? 0;
      const hitTrailingStop = peak > 2 && unrealizedCents < peak * (1 - TRAILING_STOP_PULLBACK);

      const hitSL = unrealizedCents <= -SL_CENTS;

      // TMO: only count time after game has started (don't expire pregame positions early)
      const gameStartMs    = ms?.commenceTimeMs ?? 0;
      const gameHasStarted = gameStartMs > 0 ? now > gameStartMs : true;
      const timeSinceGameStart = gameStartMs > 0 ? Math.max(0, now - gameStartMs) : timeSinceEntry;
      const hitTMO = gameHasStarted && timeSinceGameStart > EXIT_TIMEOUT_SEC * 1000;

      const needsExit = hitTP || hitTrailingStop || hitSL || hitTMO;
      const exitReason = hitTP ? "TP" : hitTrailingStop ? "TRAIL" : hitSL ? "SL" : "TMO";

      // Helper: compute aggressive exit price — post at bid (YES sell) or NO-bid (NO sell)
      // IOC + bid price = immediate taker fill
      const placeExitOrder = async (reason: string) => {
        const yesBid = (ms?.kalshiYesBid ?? 0) > 0 ? ms!.kalshiYesBid : currentMid;
        const yesAsk = (ms?.kalshiYesAsk ?? 1) < 1 ? ms!.kalshiYesAsk : currentMid;
        // Escalate aggressiveness: after 2 retries drop 5c below bid; after 5 retries sell at 1c
        const attempts = pos.exitAttempts ?? 0;
        let exitPriceCents = pos.side === "yes"
          ? Math.max(1,  Math.round(yesBid * 100))
          : Math.min(99, Math.round((1 - yesAsk) * 100));
        if (attempts >= 5) {
          exitPriceCents = pos.side === "yes" ? 1 : 99; // dump at any price
        } else if (attempts >= 2) {
          exitPriceCents = pos.side === "yes"
            ? Math.max(1, exitPriceCents - 5)
            : Math.min(99, exitPriceCents + 5);
        }
        const exitPriceDollars = ((pos.side === "yes" ? exitPriceCents : 100 - exitPriceCents) / 100).toFixed(4);
        const exitOrder = await createOrder({
          ticker:          pos.ticker,
          side:            pos.side,
          action:          "sell",
          type:            "limit",
          time_in_force:   "fill_or_kill",
          [pos.side === "yes" ? "yes_price_dollars" : "no_price_dollars"]: exitPriceDollars,
          count_fp:        pos.countFp,
          client_order_id: uuidv4(),
        });
        pos.exitOrderId  = exitOrder.order_id;
        pos.status       = "exit_placed";
        pos.exitAttempts++;
        log(`Exit placed [${reason}]: ${pos.ticker} @${exitPriceCents}c (IOC)`);
      };

      if (needsExit && pos.status === "awaiting_exit" && !pos.exitOrderId) {
        log(`Exit trigger [${exitReason}] ${pos.ticker}: unrealized=${unrealizedCents.toFixed(1)}c peak=${peak.toFixed(1)}c edge=${edgeCents.toFixed(1)}c`);
        try {
          await placeExitOrder(exitReason);
        } catch (err) {
          const msg = (err as Error).message;
          // Market closed/resolved — stop retrying, Kalshi will auto-settle
          if (msg.includes("MARKET_NOT_ACTIVE") || msg.includes("409")) {
            log(`Market resolved, awaiting Kalshi settlement: ${pos.ticker}`);
            pos.status = "pending_settlement";
          } else {
            warn(`Exit failed: ${msg}`);
            pos.exitAttempts++;
          }
        }
      }

      // Escalation: if exit_placed but IOC order is gone and position still open, retry immediately
      if (pos.status === "exit_placed" && pos.exitOrderId) {
        const restingExit = apiOrders.find(o => o.order_id === pos.exitOrderId);
        if (!restingExit) {
          // IOC was consumed (filled or canceled) — if position still shows in API it was partial/canceled
          log(`Exit IOC expired, retrying: ${pos.ticker}`);
          pos.exitOrderId = undefined;
          pos.status      = "awaiting_exit";
          try {
            await placeExitOrder(exitReason);
          } catch (err) {
            warn(`Exit retry failed: ${(err as Error).message}`);
          }
        } else {
          // Old exit order is still resting — cancel it so contracts are freed, then retry
          log(`Canceling stale exit order and retrying: ${pos.ticker}`);
          await cancelOrder(pos.exitOrderId).catch(() => null);
          pos.exitOrderId = undefined;
          pos.status      = "awaiting_exit";
          try {
            await placeExitOrder(exitReason);
          } catch (err) {
            warn(`Exit retry after cancel failed: ${(err as Error).message}`);
          }
        }
      }
    }

    saveState();
  } catch (err) {
    warn(`manageExits error: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi WebSocket
// ─────────────────────────────────────────────────────────────────────────────

interface KalshiWsMsg {
  type: string;
  msg?: Record<string, unknown>;
  id?: number;
}

function handleKalshiSnapshot(msg: Record<string, unknown>): void {
  const ticker = msg["market_ticker"] as string;
  if (!ticker || !markets.has(ticker)) return;

  const ob = getOrCreateOrderbook(ticker);
  ob.yes.clear();
  ob.no.clear();

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

  const price = msg["price"] as number;
  const delta = msg["delta"] as number;
  const side  = msg["side"]  as "yes" | "no";

  const ob   = getOrCreateOrderbook(ticker);
  const book = side === "yes" ? ob.yes : ob.no;

  if (delta > 0) {
    book.set(price, (book.get(price) ?? 0) + delta);
  } else {
    const cur = (book.get(price) ?? 0) + delta;
    if (cur <= 0) book.delete(price);
    else book.set(price, cur);
  }

  if (book.size > ORDERBOOK_DEPTH * 2) {
    const sorted = [...book.entries()].sort((a, b) => b[0] - a[0]).slice(0, ORDERBOOK_DEPTH);
    book.clear();
    for (const [k, v] of sorted) book.set(k, v);
  }

  // Mark market as live after first delta
  const ms2 = markets.get(ticker);
  if (ms2 && !ms2.receivedKalshiSnapshot) ms2.receivedKalshiSnapshot = true;

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
    kalshiWs.send(JSON.stringify({
      id: wsMessageId++, cmd: "subscribe",
      params: { channels: ["orderbook_delta"], market_tickers: batch },
    }));
  }
  log(`Kalshi: subscribed ${tickers.length} markets (orderbook_delta)`);
}

function startKalshiPing(): void {
  if (kalshiPingTimer) clearInterval(kalshiPingTimer);
  kalshiPingTimer = setInterval(() => {
    if (kalshiWs?.readyState === WebSocket.OPEN) kalshiWs.ping();
  }, WS_PING_INTERVAL_MS);
}

function connectKalshiWs(): void {
  log("Connecting Kalshi WS...");

  let authHeaders: Record<string, string>;
  try {
    authHeaders = buildKalshiAuthHeaders();
  } catch (err) {
    warn(`WS auth build failed: ${(err as Error).message}`);
    return;
  }

  // Pass auth headers in the HTTP upgrade request (Kalshi requires header-based auth)
  const ws = new WebSocket(KALSHI_WS_URL, { headers: authHeaders });
  kalshiWs = ws;

  ws.on("open", () => {
    log("Kalshi WS open — authenticated via headers");
    kalshiReconnectDelay = WS_RECONNECT_INITIAL_MS;
    startKalshiPing();
    // Auth is header-based; subscribe immediately on open
    subscribeKalshiChannels();
  });

  ws.on("message", (data: Buffer) => {
    let msg: KalshiWsMsg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case "orderbook_snapshot":
        if (msg.msg) handleKalshiSnapshot(msg.msg);
        break;
      case "orderbook_delta":
        if (msg.msg) handleKalshiDelta(msg.msg);
        break;
      case "subscribed":
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
    log(`Kalshi WS closed — reconnect in ${kalshiReconnectDelay / 1000}s`);
    setTimeout(() => {
      if (running) connectKalshiWs();
      kalshiReconnectDelay = Math.min(kalshiReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    }, kalshiReconnectDelay);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Market Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadMarkets(): void {
  const parsed = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8")) as { markets?: ProcessedMarket[] } | ProcessedMarket[];
  const raw: ProcessedMarket[] = Array.isArray(parsed) ? parsed : (parsed as { markets?: ProcessedMarket[] }).markets ?? [];
  let loaded = 0;

  for (const m of raw) {
    const s = m.status.toLowerCase();
    if (s !== "open" && s !== "active") continue;

    // Include: markets with a cross-edge signal, OR any live game ticker with High/Med actionability
    const hasEdge      = !!m.crossEdge;
    const isGameMarket = m.ticker.toUpperCase().includes("GAME-");
    const isActionable = m.actionability === "High" || m.actionability === "Med";
    if (!hasEdge && !(isGameMarket && isActionable)) continue;

    // Preserve existing in-memory state (signalFired, liveTicksSeen, priceHistory, etc.)
    // so that auto-ingest reloads don't reset locks on already-played games.
    const existing = markets.get(m.ticker);
    markets.set(m.ticker, {
      ticker:       m.ticker,
      title:        m.title ?? m.ticker,
      subtitle:     (m as ProcessedMarket & { subtitle?: string }).subtitle ?? "",
      kalshiMid:    existing?.kalshiMid    ?? (m.yesMid  > 0 ? m.yesMid  / 100 : 0.5),
      kalshiYesBid: existing?.kalshiYesBid ?? (m.yesBid  > 0 ? m.yesBid  / 100 : 0),
      kalshiYesAsk: existing?.kalshiYesAsk ?? (m.yesAsk  > 0 ? m.yesAsk  / 100 : 1),
      booksMid:     existing?.booksMid     ?? 0,
      priceHistory:           existing?.priceHistory           ?? [],
      lastSignalCheck:        existing?.lastSignalCheck        ?? 0,
      receivedKalshiSnapshot: existing?.receivedKalshiSnapshot ?? false,
      crossEdgeGapPct:    Math.abs(m.crossEdge?.gap ?? 0),
      crossEdgeDirection: m.crossEdge?.direction ?? null,
      commenceTimeMs: existing?.commenceTimeMs ?? 0,
      liveTicksSeen:  existing?.liveTicksSeen  ?? 0,
      signalFired:    existing?.signalFired    ?? false,
    });
    loaded++;
  }

  log(`Loaded ${loaded} active markets from ${path.basename(MARKETS_FILE)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Reporting
// ─────────────────────────────────────────────────────────────────────────────

function logStatus(): void {
  const openPos    = Object.keys(state.openPositions).length;
  const pending    = Object.keys(state.pendingEntries).length;
  const booksLive  = [...markets.values()].filter(m => m.booksMid > 0).length;
  const kalshiLive = [...markets.values()].filter(m => m.receivedKalshiSnapshot).length;
  const kStatus    = kalshiWs?.readyState === WebSocket.OPEN ? "UP" : "DOWN";
  const trStatus   = trConnected ? "UP" : "DOWN";

  // Update exposure in state and persist for dashboard
  state.totalExposureUsd = Object.values(state.openPositions).reduce((s, p) => s + p.costUsd, 0)
                         + Object.values(state.pendingEntries).reduce((s, p) => s + p.costUsd, 0);
  saveState();

  log(
    `PnL=$${state.realizedPnlUsd.toFixed(2)} | ` +
    `pos=${openPos} pend=${pending} | ` +
    `kalshi=${kStatus} ${kalshiLive}/${markets.size} | ` +
    `TR=${trStatus} events=${eventMap.size} msgs=${trMsgCount} matched=${trMatchCount} | ` +
    `books=${booksLive}/${markets.size}`,
  );
}

function logUnmatchedMarkets(): void {
  const unmatched: string[] = [];
  for (const ms of markets.values()) {
    if (ms.booksMid > 0) continue;
    const yesTeam = parseYesTeam(ms.title, ms.subtitle);
    if (!yesTeam) unmatched.push(`${ms.ticker}: no team parseable`);
    else {
      const tNorm = normalizeTeamName(yesTeam);
      unmatched.push(`${ms.ticker}: "${yesTeam}" (norm="${tNorm}") not in books`);
    }
  }
  if (unmatched.length > 0) {
    log(`Unmatched (${unmatched.length}): ${unmatched.join(" | ")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Ingest Loop
// ─────────────────────────────────────────────────────────────────────────────

function startAutoIngest(): void {
  // Only refresh the Kalshi market list (not odds — TheRundown WS handles that now)
  const run = () => {
    log("Auto-ingest: refreshing Kalshi markets...");
    const child = spawn("npm", ["run", "ingest:kalshi"], {
      cwd: process.cwd(), shell: true, stdio: "pipe",
    });
    child.on("close", (code) => log(`Auto-ingest: done (exit ${code})`));
    child.on("error", (err) => warn(`Auto-ingest error: ${err.message}`));
  };
  // Refresh Kalshi market list every 30 min to pick up new markets
  setInterval(run, 30 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (DRY_RUN) log("⚠️  DRY RUN MODE — no real orders will be placed");
  log("Kalshi WS Autopilot starting (TheRundown live feed mode)...");
  log(`  Markets file:  ${MARKETS_FILE}`);
  log(`  State file:    ${STATE_FILE}`);
  log(`  Odds data dir: ${ODDS_DATA_DIR}`);

  if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY_PEM_PATH) {
    console.error("Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM_PATH");
    process.exit(1);
  }

  const hasTR = !!process.env.THERUNDOWN_API_KEY;
  if (!hasTR) warn("THERUNDOWN_API_KEY not set — falling back to file-based odds polling");

  loadState();

  // Reconcile open positions from Kalshi REST on startup — catches any positions
  // that were placed but not tracked (e.g. due to manageExits fetch failures).
  if (!DRY_RUN) {
    try {
      const [liveOrders, livePositions] = await Promise.all([getOrders("resting"), getPositions()]);
      let reconciled = 0;
      for (const pos of livePositions) {
        const ticker = (pos as any).ticker as string;
        const posSize = Number((pos as any).position_fp ?? 0);
        if (!ticker || posSize === 0) continue;
        // Check if already tracked
        const alreadyTracked = Object.values(state.openPositions).some(p => p.ticker === ticker)
                            || Object.values(state.pendingEntries).some(p => p.ticker === ticker);
        if (!alreadyTracked) {
          const side: "yes" | "no" = posSize > 0 ? "yes" : "no";
          const exposure = Number((pos as any).market_exposure_dollars ?? 0);
          const clientId = `reconciled-${ticker}-${Date.now()}`;
          state.openPositions[clientId] = {
            ticker, side,
            entryPriceCents: exposure > 0 ? Math.round((exposure / Math.abs(posSize)) * 100) : 50,
            countFp: String(Math.abs(posSize)),
            costUsd: exposure,
            entryOrderId: clientId,
            entryFillTs: new Date().toISOString(),
            exitAttempts: 0,
            status: "awaiting_exit",
            leaderAtEntry: "BOOKS",
            directionAtEntry: "UP",
            peakUnrealizedCents: 0,
          };
          state.playedGames[wsGameKey(ticker)] = true;
          reconciled++;
          log(`Reconciled untracked position: ${ticker} ${side} x${Math.abs(posSize)}`);
        }
      }
      if (reconciled > 0) saveState();
    } catch (e) {
      warn(`Startup reconciliation failed: ${(e as Error).message}`);
    }
  }

  loadMarkets();

  if (markets.size === 0) {
    console.error(`No markets loaded from ${MARKETS_FILE}`);
    process.exit(1);
  }

  // Phase 1: Prime books odds
  if (hasTR) {
    // Load today's events from TheRundown REST API → prime eventMap + booksMap
    await loadTodayEvents();
    // Check every 30min; reload if TTL expired (1h) — picks up new Pinnacle lines posted during the day
    setInterval(async () => {
      if (Date.now() - eventMapLoadedAt > TR_EVENT_MAP_TTL_MS) {
        log("Refreshing TR event map (hourly)...");
        await loadTodayEvents().catch(e => warn(`TR event refresh error: ${(e as Error).message}`));
      }
    }, 30 * 60 * 1000);
  } else {
    // Fallback: read from local odds files
    refreshBooksOdds();
  }

  const booksLive = [...markets.values()].filter(m => m.booksMid > 0).length;
  log(`Books primed: ${booksMap.size} teams | ${booksLive}/${markets.size} markets matched`);
  logUnmatchedMarkets();

  // Phase 2: Connect live feeds
  if (hasTR) {
    connectTheRundownWs();
  }
  connectKalshiWs();

  // Fallback file-poll loop (5 min) for any markets TR doesn't cover
  if (hasTR) {
    setInterval(() => {
      const unmatched = [...markets.values()].filter(m => m.booksMid === 0).length;
      if (unmatched > 0) refreshBooksOdds();
    }, ODDS_REFRESH_INTERVAL_MS);
  }

  // Auto-ingest: refresh Kalshi market list every 30 min
  startAutoIngest();

  const balance = await getBalance().catch(() => null);
  const balStr  = balance ? `$${(Number(balance.balance ?? 0) / 100).toFixed(2)}` : "unknown";

  const modeStr = DRY_RUN
    ? (hasTR ? "📄 DRY RUN + TheRundown live" : "📄 DRY RUN + file-poll")
    : (hasTR ? "TheRundown live" : "file-poll fallback");
  notifyDiscord(
    `**WS Autopilot started** (${modeStr}) | ${markets.size} markets | ${booksLive} books-matched | balance=${balStr}`,
  );
  log(`Balance: ${balStr} | ${markets.size} markets | ${booksLive} books-matched`);

  const startTime   = Date.now();
  let loopCount     = 0;
  let exitLoopCount = 0;

  while (running) {
    loopCount++;

    if (isKillSwitchSet()) {
      log("Kill switch detected. Shutting down...");
      running = false;
      break;
    }

    if (Date.now() - startTime > RUN_DURATION_MS) {
      log("Max run duration reached. Shutting down...");
      running = false;
      break;
    }

    // For non-TR mode, fall back to file polling every 5 min
    if (!hasTR) refreshBooksOdds();

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

  // Graceful shutdown
  log("Shutting down...");
  running = false;
  if (kalshiPingTimer) clearInterval(kalshiPingTimer);
  kalshiWs?.close();
  therundownWs?.close();

  if (DRY_RUN) {
    // Close all remaining paper positions at current mid
    await managePaperExits().catch(() => null);
    const openRemaining = Object.keys(state.openPositions).length;
    if (openRemaining > 0) {
      log(`${openRemaining} paper positions still open at shutdown (not yet exited)`);
    }
    const summary = `📄 **DRY RUN COMPLETE** | Paper PnL=$${state.realizedPnlUsd.toFixed(2)} | Trades=${state.ordersInLastHour.length}`;
    log(summary);
    notifyDiscord(summary);
  } else {
    await cancelAllRestingOrders().catch(() => null);
    notifyDiscord(`**WS Autopilot stopped** | Final PnL=$${state.realizedPnlUsd.toFixed(2)}`);
  }
  saveState();
  log(`Done. Session PnL=$${state.realizedPnlUsd.toFixed(2)}`);
}

process.on("SIGINT",  () => { log("SIGINT received"); running = false; });
process.on("SIGTERM", () => { log("SIGTERM received"); running = false; });

main().catch((err) => {
  console.error("[ws-autopilot] Fatal:", err);
  process.exit(1);
});
