/**
 * watch-kalshi-books.ts — KalshiEdge real-time orderbook watcher
 *
 * Connects to Kalshi WebSocket, subscribes to orderbook updates for top
 * tickers, and alerts on price dislocations.
 *
 * Requires: Node.js 22+ (native globalThis.WebSocket)
 * Usage:    npm run watch:kalshi
 *
 * ENV VARS:
 *   KALSHI_ENV                   demo | prod  (default: demo)
 *   KALSHI_API_KEY_ID            API key UUID (required for private WS channels)
 *   KALSHI_PRIVATE_KEY_PEM_PATH  RSA private key PEM path (required for WS auth)
 *   KALSHI_WS_URL                Override WS URL
 *   KALSHI_WATCH_MARKETS         Comma-separated tickers to watch (else: top N from latest-kalshi.json)
 *   KALSHI_WATCH_MAX_TICKERS     Max tickers to auto-load (default: 20)
 *   KALSHI_DISLOCATION_CENTS     Alert threshold in ¢ (default: 3)
 *   KALSHI_WINDOW_MS             Dislocation detection window in ms (default: 30000)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Load .env (best-effort)
try {
  const envFile = path.resolve(process.cwd(), ".env");
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch { /* no .env */ }

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KALSHI_ENV = (process.env.KALSHI_ENV ?? "prod") as "demo" | "prod";
const WS_URL =
  process.env.KALSHI_WS_URL ??
  (KALSHI_ENV === "prod"
    ? "wss://api.elections.kalshi.com/trade-api/ws/v2"
    : "wss://demo-api.kalshi.co/trade-api/ws/v2");

const MAX_TICKERS = parseInt(process.env.KALSHI_WATCH_MAX_TICKERS ?? "20", 10);
const DISLOCATION_CENTS = parseFloat(process.env.KALSHI_DISLOCATION_CENTS ?? "3");
const WINDOW_MS = parseInt(process.env.KALSHI_WINDOW_MS ?? "30000", 10);
const RECONNECT_DELAY_MS = 5_000;
const PING_INTERVAL_MS = 9_000; // server sends ping every 10s; we send pong proactively

// ---------------------------------------------------------------------------
// Native WebSocket type shim (Node.js 22+)
// ---------------------------------------------------------------------------

interface NativeWebSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly CLOSED: number;
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onclose: ((e: CloseEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NativeWS = (globalThis as any).WebSocket as new (url: string) => NativeWebSocket;

if (!NativeWS) {
  console.error(
    "[watch] ERROR: Node.js 22+ required for native WebSocket.\n" +
      "  Upgrade Node.js or set KALSHI_WS_URL and install the 'ws' npm package.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth helpers (same RSA signing logic as ingest-kalshi.ts)
// ---------------------------------------------------------------------------

function signKalshi(
  method: string,
  urlPath: string,
  timestampMs: string,
  privateKeyPem: string,
): string {
  // Kalshi requires RSA-PSS and signs path WITHOUT query params
  const signPath = urlPath.split("?")[0];
  const message = `${timestampMs}${method.toUpperCase()}${signPath}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  return signer.sign(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );
}

function loadPrivateKey(): string | null {
  const p = process.env.KALSHI_PRIVATE_KEY_PEM_PATH;
  if (!p) return null;
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function buildWsLoginMsg(id: number): string | null {
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKey = loadPrivateKey();

  if (!apiKeyId || !privateKey) {
    // No RSA keys — try unauthenticated (public markets only)
    return null;
  }

  const ts = String(Date.now());
  // Kalshi WS login signature uses GET + the WS path
  const sig = signKalshi("GET", "/trade-api/ws/v2", ts, privateKey);

  return JSON.stringify({
    id,
    cmd: "login",
    params: {
      apiKey: apiKeyId,
      signature: sig,
      timestamp: parseInt(ts, 10),
    },
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KalshiOutput {
  markets: Array<{
    ticker: string;
    title: string;
    openInterest: number;
    isSports: boolean;
  }>;
}

interface PriceSnap {
  yesBid: number | null;
  yesAsk: number | null;
  mid: number | null;
  ts: number;
}

interface Dislocation {
  ticker: string;
  title?: string;
  before: PriceSnap;
  after: PriceSnap;
  moveCents: number;
  windowMs: number;
  detectedAt: string;
}

// WS message shapes
interface WsOrderbookDelta {
  type: "orderbook_delta" | "orderbook_snapshot";
  msg?: {
    market_ticker?: string;
    yes?: Array<[number, number]>; // [price_cents, delta_contracts]
    no?: Array<[number, number]>;
  };
  market_ticker?: string; // alternate location in some versions
}

interface WsSubscribeMsg {
  type?: string;
  id?: number;
  msg?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Load tickers from env or latest-kalshi.json
// ---------------------------------------------------------------------------

function loadWatchTickers(root: string): Array<{ ticker: string; title: string }> {
  // Explicit list from env takes priority
  const envList = process.env.KALSHI_WATCH_MARKETS;
  if (envList) {
    return envList.split(",").map((t) => ({ ticker: t.trim(), title: t.trim() }));
  }

  const jsonPath = path.join(root, "data", "processed", "latest-kalshi.json");
  if (!fs.existsSync(jsonPath)) {
    console.warn("[watch] latest-kalshi.json not found — run npm run ingest:kalshi first");
    return [];
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as KalshiOutput;
  const sorted = [...data.markets].sort((a, b) => b.openInterest - a.openInterest);
  return sorted.slice(0, MAX_TICKERS).map((m) => ({
    ticker: m.ticker,
    title: m.title ?? m.ticker,
  }));
}

// ---------------------------------------------------------------------------
// Price tracker — rolling ring buffer per ticker
// ---------------------------------------------------------------------------

const RING_SIZE = 30;
const priceHistory = new Map<string, PriceSnap[]>();
const titleMap = new Map<string, string>();
const bestBidTracker = new Map<string, Map<number, number>>(); // ticker → price→size YES bids
const bestNoBidTracker = new Map<string, Map<number, number>>(); // ticker → price→size NO bids

function updateOrderbookSide(
  store: Map<string, Map<number, number>>,
  ticker: string,
  levels: Array<[number, number]>,
  isSnapshot: boolean,
): void {
  if (!store.has(ticker)) store.set(ticker, new Map());
  const book = store.get(ticker)!;

  if (isSnapshot) book.clear();

  for (const [price, delta] of levels) {
    const prev = book.get(price) ?? 0;
    const next = isSnapshot ? delta : prev + delta;
    if (next <= 0) book.delete(price);
    else book.set(price, next);
  }
}

function bestPrice(store: Map<string, Map<number, number>>, ticker: string): number | null {
  const book = store.get(ticker);
  if (!book || book.size === 0) return null;
  return Math.max(...book.keys());
}

function computeSnap(ticker: string): PriceSnap {
  const yesBid = bestPrice(bestBidTracker, ticker);
  const noBid = bestPrice(bestNoBidTracker, ticker);
  const yesAsk = noBid !== null ? 100 - noBid : null;
  const mid =
    yesBid !== null && yesAsk !== null
      ? (yesBid + yesAsk) / 2
      : yesBid ?? yesAsk ?? null;

  return { yesBid, yesAsk, mid, ts: Date.now() };
}

function recordSnap(ticker: string, snap: PriceSnap): Dislocation | null {
  if (!priceHistory.has(ticker)) priceHistory.set(ticker, []);
  const history = priceHistory.get(ticker)!;
  history.push(snap);
  if (history.length > RING_SIZE) history.shift();

  if (snap.mid === null) return null;

  const windowStart = snap.ts - WINDOW_MS;
  const baseline = history.find((h) => h.ts >= windowStart && h !== snap);
  if (!baseline || baseline.mid === null) return null;

  const moveCents = Math.abs(snap.mid - baseline.mid);
  if (moveCents < DISLOCATION_CENTS) return null;

  return {
    ticker,
    title: titleMap.get(ticker),
    before: baseline,
    after: snap,
    moveCents: Math.round(moveCents * 10) / 10,
    windowMs: snap.ts - baseline.ts,
    detectedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Alert output
// ---------------------------------------------------------------------------

const alertLogPath = path.join(
  process.cwd(),
  "data",
  "processed",
  "kalshi-alerts.jsonl",
);
const alertCooldown = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60_000;

function onDislocation(d: Dislocation): void {
  const last = alertCooldown.get(d.ticker) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;
  alertCooldown.set(d.ticker, Date.now());

  const arrow = d.after.mid! > d.before.mid! ? "▲" : "▼";
  const label = d.title
    ? d.title.slice(0, 70) + (d.title.length > 70 ? "…" : "")
    : d.ticker;
  const secs = Math.round(d.windowMs / 1000);

  console.log(
    `\n[DISLOCATION ${arrow}] ${label}\n` +
      `  ${d.ticker} · move: ${d.moveCents}¢ in ${secs}s\n` +
      `  Before mid: ${d.before.mid?.toFixed(1)}¢  After mid: ${d.after.mid?.toFixed(1)}¢\n` +
      `  YES bid/ask: ${d.after.yesBid ?? "—"}¢ / ${d.after.yesAsk ?? "—"}¢\n`,
  );

  try {
    fs.mkdirSync(path.dirname(alertLogPath), { recursive: true });
    fs.appendFileSync(alertLogPath, JSON.stringify(d) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[watch] Alert log write failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

let msgId = 1;

function connect(tickers: Array<{ ticker: string; title: string }>): void {
  if (tickers.length === 0) {
    console.error("[watch] No tickers to watch — exiting");
    process.exit(1);
  }

  for (const { ticker, title } of tickers) titleMap.set(ticker, title);
  const tickerList = tickers.map((t) => t.ticker);

  console.log(`[watch] Connecting to ${WS_URL}...`);
  const ws = new NativeWS(WS_URL);
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  ws.onopen = () => {
    console.log("[watch] Connected.");

    // Attempt RSA login (required for private channels / authenticated orderbooks)
    const loginMsg = buildWsLoginMsg(msgId++);
    if (loginMsg) {
      ws.send(loginMsg);
      console.log("[watch] RSA login sent.");
    } else {
      console.log("[watch] No RSA keys configured — connecting unauthenticated (public channels only).");
    }

    // Subscribe to orderbook_delta for our tickers
    ws.send(
      JSON.stringify({
        id: msgId++,
        cmd: "subscribe",
        params: {
          channels: ["orderbook_delta"],
          market_tickers: tickerList,
        },
      }),
    );
    console.log(`[watch] Subscribed to ${tickerList.length} tickers. Watching for ${DISLOCATION_CENTS}¢ moves in ${WINDOW_MS / 1000}s...`);

    // Proactive pong to keep connection alive
    pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ id: msgId++, cmd: "ping" }));
      }
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const raw = JSON.parse(event.data as string) as WsSubscribeMsg | WsOrderbookDelta;
      handleMessage(raw as WsOrderbookDelta);
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = (event: CloseEvent) => {
    if (pingTimer) clearInterval(pingTimer);
    console.warn(
      `[watch] Disconnected (code=${event.code}) — reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`,
    );
    setTimeout(() => connect(tickers), RECONNECT_DELAY_MS);
  };

  ws.onerror = (event: Event) => {
    console.error("[watch] WebSocket error:", event);
    // onclose fires next and handles reconnect
  };
}

function handleMessage(msg: WsOrderbookDelta): void {
  const type = msg.type;
  if (!type || !["orderbook_delta", "orderbook_snapshot"].includes(type)) return;

  const data = msg.msg ?? msg;
  const ticker = (data as { market_ticker?: string }).market_ticker;
  if (!ticker) return;

  const isSnapshot = type === "orderbook_snapshot";

  // YES bids update (sorted desc by price: best bid = max price)
  const yesBids = (data as { yes?: Array<[number, number]> }).yes ?? [];
  if (yesBids.length > 0) {
    updateOrderbookSide(bestBidTracker, ticker, yesBids, isSnapshot);
  }

  // NO bids update
  const noBids = (data as { no?: Array<[number, number]> }).no ?? [];
  if (noBids.length > 0) {
    updateOrderbookSide(bestNoBidTracker, ticker, noBids, isSnapshot);
  }

  if (yesBids.length === 0 && noBids.length === 0) return;

  const snap = computeSnap(ticker);
  const dislocation = recordSnap(ticker, snap);
  if (dislocation) onDislocation(dislocation);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const root = process.cwd();
const tickers = loadWatchTickers(root);

if (tickers.length === 0) {
  console.error("[watch] No tickers loaded. Run `npm run ingest:kalshi` first.");
  process.exit(1);
}

console.log(
  `[watch] KalshiEdge book watcher (env=${KALSHI_ENV})\n` +
    `  Tickers: ${tickers.length}\n` +
    `  Alert threshold: ${DISLOCATION_CENTS}¢ in ${WINDOW_MS / 1000}s\n` +
    `  Alert log: ${alertLogPath}\n`,
);

connect(tickers);

process.on("SIGINT", () => {
  console.log("\n[watch] Shutting down.");
  process.exit(0);
});
