/**
 * ingest-kalshi.ts — KalshiEdge market ingest v1
 *
 * READ-ONLY: market discovery + orderbook snapshots + AGENTS.md injection.
 * No trade execution.
 *
 * ENV VARS (see KALSHI_TOOLS.md for full reference):
 *   KALSHI_ENV                   demo | prod  (default: demo)
 *   KALSHI_API_KEY_ID            API key UUID from Kalshi UI
 *   KALSHI_PRIVATE_KEY_PEM_PATH  Path to RSA private key PEM file
 *   KALSHI_API_KEY               Legacy simple key (fallback if no RSA keys)
 *   KALSHI_BASE_URL              Override REST base URL
 *   KALSHI_TICKER_PREFIXES       Comma-separated prefixes for sports filter
 *   POLYEDGE_AGENTS_MD_PATH      Override workspace AGENTS.md path
 *   OPENCLAW_WORKSPACE_KALSHI    Workspace dir (default: C:\Users\nbber\.openclaw\workspace-kalshi)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Load .env (best-effort — ignore if file missing)
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

const BASE_URL =
  process.env.KALSHI_BASE_URL ??
  (KALSHI_ENV === "prod"
    ? "https://api.elections.kalshi.com/trade-api/v2"
    : "https://demo-api.kalshi.co/trade-api/v2");

const TICKER_PREFIXES: string[] = process.env.KALSHI_TICKER_PREFIXES
  ? process.env.KALSHI_TICKER_PREFIXES.split(",").map((s) => s.trim().toUpperCase())
  : [];

// Ticker prefixes to always exclude (no Pinnacle coverage, not tradeable).
const TICKER_EXCLUDE_PREFIXES: string[] = ["KXCOD"];

// Max markets to keep after initial discovery sort (before orderbook fetch).
// Keeps memory and API calls manageable when Kalshi returns 10k+ combo markets.
const MAX_MARKETS = parseInt(process.env.KALSHI_MAX_MARKETS ?? "500", 10);

// Max markets to actually fetch orderbooks for (top N by open interest).
const MAX_OB_FETCH = parseInt(process.env.KALSHI_MAX_OB ?? "200", 10);

// Tickers containing these substrings are cross-category combo markets — skip them.
const SKIP_TICKER_PATTERNS = ["CROSSCATEGORY", "MVECROSS", "COMBO"];
function isComboCMarket(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return SKIP_TICKER_PATTERNS.some((p) => t.includes(p));
}

function isLikelyGameTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return t.includes("GAME-") || t.startsWith("KXNBAGAME") || t.startsWith("KXNFLGAME") || t.startsWith("KXNHLGAME") || t.startsWith("KXMLBGAME");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KalshiMarket {
  ticker: string;
  title?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  category?: string;
  event_ticker?: string;
  status: "open" | "closed" | "settled" | "unopened";
  close_time?: string;          // ISO8601
  expiration_time?: string;     // ISO8601 (alias)
  volume?: number;              // total contracts traded
  volume_24h?: number;
  open_interest?: number;
  open_interest_fp?: string;    // string dollars (new API format)
  liquidity?: number;
  last_price?: number;          // last traded price in cents
  last_price_dollars?: string;  // string dollars (new API format)
  yes_ask?: number;             // cents (from market list — less reliable)
  yes_bid?: number;
  no_ask?: number;
  no_bid?: number;
  yes_ask_dollars?: string;     // string dollars (new API format)
  yes_bid_dollars?: string;
  no_ask_dollars?: string;
  no_bid_dollars?: string;
}

interface KalshiEvent {
  event_ticker: string;
  title?: string;
  category?: string;
  sub_title?: string;
  close_time?: string;
  markets?: KalshiMarket[];
}

// API returns tuples: [price_cents, size_contracts] (legacy) or [price_dollars_str, size_fp_str] (new)
type KalshiOrderbookLevel = [number, number];
type KalshiOrderbookLevelFp = [string, string];

interface KalshiOrderbook {
  yes?: KalshiOrderbookLevel[];
  no?: KalshiOrderbookLevel[];
}

interface KalshiOrderbookFp {
  yes_dollars?: KalshiOrderbookLevelFp[];
  no_dollars?: KalshiOrderbookLevelFp[];
}

interface KalshiOrderbookResponse {
  orderbook?: KalshiOrderbook;
  orderbook_fp?: KalshiOrderbookFp;
}

interface CrossEdge {
  pickTeam: string;
  opponent: string;
  modelConfidence: number;     // 0–100 fair probability
  kalshiImplied: number;       // 0–100 from YES mid
  gap: number;
  direction: "model-higher" | "model-lower";
  matchedVia: string;
  gameDate: string;
  tMinusMinutes?: number;
  injuryContext?: {
    pickInjuredStars: string[];  // OUT/Doubtful players on pick team (risk flag)
    oppInjuredStars: string[];   // OUT/Doubtful players on opp team (opportunity flag)
  };
  movementSignal?: {
    delta30m: number | null;   // cents change over last 30 min
    movingToward: boolean;     // true = market moving toward model target
    velocity: number;          // cents per minute (absolute)
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
  eventTicker?: string;
  tournamentEdge?: TournamentEdge;
  // Orderbook-derived (null if side missing)
  yesBid: number | null;        // cents
  yesAsk: number | null;        // cents (synthesized from best NO bid)
  yesMid: number | null;        // cents
  noBid: number | null;         // cents
  noAsk: number | null;         // cents (synthesized from best YES bid)
  spread: number | null;        // cents (null = incomplete book)
  topYesBidNotional: number;    // USD
  topYesAskNotional: number;    // USD (qty from best NO bid side)
  impliedProbYes: number | null; // percentage (from YES mid)
  volume: number;
  openInterest: number;
  liquidity: number;
  status: string;
  closeTime: string;
  actionability: "High" | "Med" | "Low";
  isSports: boolean;
  crossEdge?: CrossEdge;
}

interface KalshiOutput {
  fetchedAtIsoUtc: string;
  fetchedAtIsoEt: string;
  env: "demo" | "prod";
  totalFetched: number;
  sportsCount: number;
  crossEdgeCount: number;
  tournamentEdgeCount: number;
  markets: ProcessedMarket[];
  sportsMarkets: ProcessedMarket[];
  crossEdgeMarkets: ProcessedMarket[];
  tournamentEdgeMarkets: ProcessedMarket[];
  stats: {
    apiCallsMade: number;
    eventsScanned: number;
    orderbooksFetched: number;
    orderbookErrors: number;
    excludedClosed: number;
  };
}

interface BestBet {
  league: string;
  matchup: string;
  pickTeam: string;
  opponent: string;
  confidence: number;
  gameDate: string;
  spread?: number;
  modelSpread?: number;
  line?: string;
  subtitle?: string;        // For soccer: outcome label matching Kalshi market subtitle
  soccerSide?: "home" | "away" | "draw"; // Soccer outcome type
}

interface CrossEdgeMiss {
  marketTicker: string;
  marketTitle: string;
  pickTeam: string;
  opponent: string;
  reason: "pick_unmatched" | "opp_unmatched" | "date_mismatch" | "below_threshold" | "subtitle_unmatched";
  gap?: number;
}

// ---------------------------------------------------------------------------
// RSA auth helpers
// ---------------------------------------------------------------------------

let cachedPrivateKey: string | null = null;

function loadPrivateKey(): string | null {
  if (cachedPrivateKey !== null) return cachedPrivateKey;
  const pemPath = process.env.KALSHI_PRIVATE_KEY_PEM_PATH;
  if (!pemPath) return null;
  try {
    cachedPrivateKey = fs.readFileSync(pemPath, "utf-8");
    return cachedPrivateKey;
  } catch (err) {
    console.warn(`  [auth] Cannot load PEM from ${pemPath}: ${(err as Error).message}`);
    return null;
  }
}

function signKalshi(
  method: string,
  urlPath: string, // path + optional query string — query is stripped before signing
  timestampMs: string,
  privateKeyPem: string,
): string {
  // Kalshi requires RSA-PSS (not PKCS1v15) and signs path WITHOUT query params
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

function buildAuthHeaders(
  method: string,
  urlPath: string,
): Record<string, string> {
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKey = loadPrivateKey();

  if (apiKeyId && privateKey) {
    // Full RSA auth (v2)
    const ts = String(Date.now());
    const sig = signKalshi(method, urlPath, ts, privateKey);
    return {
      "KALSHI-ACCESS-KEY": apiKeyId,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": ts,
    };
  }

  // Legacy simple key fallback
  const legacyKey = process.env.KALSHI_API_KEY;
  if (legacyKey) {
    return { Authorization: legacyKey };
  }

  // Unauthenticated — works for public market endpoints
  return {};
}

// ---------------------------------------------------------------------------
// Rate-limit-aware fetch
// ---------------------------------------------------------------------------

let apiCallCount = 0;

async function fetchKalshi(
  urlPath: string,
  method = "GET",
  maxRetries = 4,
): Promise<Response> {
  const fullUrl = `${BASE_URL}${urlPath}`;
  const authHeaders = buildAuthHeaders(method, `/trade-api/v2${urlPath.startsWith("/") ? urlPath : "/" + urlPath}`);
  let delay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    apiCallCount++;
    const res = await fetch(fullUrl, {
      method,
      headers: {
        "Accept": "application/json",
        "User-Agent": "kalshiedge-ingest/1.0",
        ...authHeaders,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`Rate limited: ${fullUrl}`);
      console.warn(`  [rate-limit] 429 on ${urlPath} — backoff ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (attempt === maxRetries) throw new Error(`HTTP ${res.status} from ${urlPath}: ${body.slice(0, 120)}`);
      console.warn(`  [warn] HTTP ${res.status} from ${urlPath} — retry ${attempt + 1}/${maxRetries}`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
      continue;
    }

    return res;
  }
  throw new Error("Unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// ET time helpers
// ---------------------------------------------------------------------------

const ET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function toEtIso(date: Date): string {
  const p = ET_FORMATTER.formatToParts(date);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

function toEtDateStr(date: Date): string {
  return toEtIso(date).slice(0, 10);
}

function etDisplayStr(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

// ---------------------------------------------------------------------------
// Market discovery — GET /events?with_nested_markets=true (paginated)
// ---------------------------------------------------------------------------

async function fetchAllMarkets(): Promise<{
  markets: KalshiMarket[];
  eventsScanned: number;
}> {
  const markets: KalshiMarket[] = [];
  const seen = new Set<string>();
  let eventsScanned = 0;
  let cursor: string | undefined;
  let page = 0;
  const MAX_PAGES = parseInt(process.env.KALSHI_MAX_EVENT_PAGES ?? "100", 10); // raise coverage for live game markets

  console.log(`  [kalshi] Fetching open events (env=${KALSHI_ENV}, max_pages=${MAX_PAGES})...`);

  // Events endpoint with nested markets (most efficient — one call per page)
  do {
    const qs = new URLSearchParams({
      status: "open",
      with_nested_markets: "true",
      limit: "200",
    });
    if (cursor) qs.set("cursor", cursor);

    const res = await fetchKalshi(`/events?${qs}`);
    const data = (await res.json()) as { events?: KalshiEvent[]; cursor?: string };

    cursor = data.cursor ?? undefined;
    page++;

    for (const event of data.events ?? []) {
      eventsScanned++;
      for (const m of event.markets ?? []) {
        if (seen.has(m.ticker)) continue;
        // Skip combo/cross-category markets — they are multi-leg constructs
        if (isComboCMarket(m.ticker)) continue;
        // Skip fully dead markets unless they are explicit game markets
        // (live/in-game books can momentarily show low/zero OI/vol but are still tradable)
        const oi = (m.open_interest ?? 0) || parseFloat(m.open_interest_fp ?? "0");
        if (oi === 0 && (m.volume ?? 0) === 0 && !isLikelyGameTicker(m.ticker)) continue;

        seen.add(m.ticker);
        if (!m.category && event.category) m.category = event.category;
        if (!m.event_ticker) m.event_ticker = event.event_ticker;
        markets.push(m);
      }
    }

    if (!data.events || data.events.length === 0) break;
  } while (cursor && page < MAX_PAGES);

  console.log(
    `  [kalshi] Events: ${eventsScanned} scanned (${page} pages), ${markets.length} non-combo markets`,
  );

  // Exclude tickers with no Pinnacle coverage (e.g. esports).
  const excluded = markets.filter((m) =>
    TICKER_EXCLUDE_PREFIXES.some((p) => m.ticker.toUpperCase().startsWith(p)),
  );
  const afterExclude = markets.filter((m) =>
    !TICKER_EXCLUDE_PREFIXES.some((p) => m.ticker.toUpperCase().startsWith(p)),
  );
  if (excluded.length > 0) {
    console.log(
      `  [kalshi] Excluded ${excluded.length} markets (${TICKER_EXCLUDE_PREFIXES.join(",")}): ${markets.length} → ${afterExclude.length}`,
    );
  }

  // Apply ticker prefix filter if configured
  if (TICKER_PREFIXES.length > 0) {
    const before = afterExclude.length;
    const filtered = afterExclude.filter((m) =>
      TICKER_PREFIXES.some((p) => m.ticker.toUpperCase().startsWith(p)),
    );
    console.log(
      `  [kalshi] Ticker prefix filter (${TICKER_PREFIXES.join(",")}): ${before} → ${filtered.length}`,
    );
    return { markets: filtered, eventsScanned };
  }

  return { markets: afterExclude, eventsScanned };
}

// ---------------------------------------------------------------------------
// Orderbook fetching — GET /markets/{ticker}/orderbook (5 concurrent)
// ---------------------------------------------------------------------------

async function fetchOrderbook(ticker: string): Promise<KalshiOrderbook | null> {
  try {
    const res = await fetchKalshi(`/markets/${encodeURIComponent(ticker)}/orderbook`);
    const data = (await res.json()) as KalshiOrderbookResponse;
    // Prefer legacy cents format; fall back to new dollar-string format
    if (data.orderbook) return data.orderbook;
    if (data.orderbook_fp) {
      // Convert [price_dollars_str, size_fp_str][] → [price_cents, size_contracts][]
      const fpToLevels = (levels: KalshiOrderbookLevelFp[]): KalshiOrderbookLevel[] =>
        levels.map(([p, s]) => [Math.round(parseFloat(p) * 100), Math.round(parseFloat(s))]);
      return {
        yes: data.orderbook_fp.yes_dollars ? fpToLevels(data.orderbook_fp.yes_dollars) : undefined,
        no:  data.orderbook_fp.no_dollars  ? fpToLevels(data.orderbook_fp.no_dollars)  : undefined,
      };
    }
    return null;
  } catch (err) {
    console.warn(`  [ob] ${ticker}: ${(err as Error).message}`);
    return null;
  }
}

async function batchFetchOrderbooks(
  tickers: string[],
  concurrency = Number(process.env.KALSHI_OB_CONCURRENCY ?? 20),
): Promise<Map<string, KalshiOrderbook | null>> {
  const result = new Map<string, KalshiOrderbook | null>();
  let errors = 0;
  concurrency = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 20;

  console.log(`  [kalshi] Fetching orderbooks for ${tickers.length} tickers (concurrency=${concurrency})...`);

  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map((t) => fetchOrderbook(t).then((ob) => ({ ticker: t, ob }))),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") {
        result.set(r.value.ticker, r.value.ob);
        if (r.value.ob === null) errors++;
      } else {
        errors++;
      }
    }
    if (i + concurrency < tickers.length) await sleep(Number(process.env.KALSHI_OB_CHUNK_SLEEP_MS ?? 50));
  }

  const fetched = result.size - errors;
  console.log(`  [kalshi] Orderbooks: ${fetched}/${tickers.length} fetched, ${errors} errors`);
  return result;
}

// ---------------------------------------------------------------------------
// Process orderbook → synthesized bid/ask + notional depth
// ---------------------------------------------------------------------------

interface SynthesizedBook {
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  noBid: number | null;
  noAsk: number | null;
  spread: number | null;
  topYesBidNotional: number;
  topYesAskNotional: number;
}

function synthesizeBook(ob: KalshiOrderbook | null): SynthesizedBook {
  const EMPTY: SynthesizedBook = {
    yesBid: null,
    yesAsk: null,
    yesMid: null,
    noBid: null,
    noAsk: null,
    spread: null,
    topYesBidNotional: 0,
    topYesAskNotional: 0,
  };

  if (!ob) return EMPTY;

  // API returns tuples [price_cents, size]. Sort desc by price (best bid first).
  const yesBids = (ob.yes ?? []).slice().sort((a, b) => b[0] - a[0]);
  const noBids = (ob.no ?? []).slice().sort((a, b) => b[0] - a[0]);

  const bestYesBid = yesBids[0] ?? null;
  const bestNoBid = noBids[0] ?? null;

  const yesBid = bestYesBid ? bestYesBid[0] : null;
  const noBid = bestNoBid ? bestNoBid[0] : null;

  // Synthesize asks from the opposite side's best bid
  //   YES ask = 100 - best NO bid (someone willing to sell YES)
  //   NO ask  = 100 - best YES bid (someone willing to sell NO)
  const yesAsk = noBid !== null ? 100 - noBid : null;
  const noAsk = yesBid !== null ? 100 - yesBid : null;

  // Mid and spread
  let yesMid: number | null = null;
  let spread: number | null = null;
  if (yesBid !== null && yesAsk !== null) {
    spread = yesAsk - yesBid;
    yesMid = (yesBid + yesAsk) / 2;
  } else if (yesBid !== null) {
    yesMid = yesBid;
  } else if (yesAsk !== null) {
    yesMid = yesAsk;
  }

  // Notional depth in USD:
  //   Top YES bid notional = (price/100) * size  (buyer is paying this much per contract)
  //   Top YES ask notional = (yesAsk/100) * noBidQty  (opposite side qty sets the fill size)
  const topYesBidNotional = bestYesBid
    ? (bestYesBid[0] / 100) * bestYesBid[1]
    : 0;
  const topYesAskNotional =
    bestNoBid && yesAsk !== null
      ? (yesAsk / 100) * bestNoBid[1]
      : 0;

  return {
    yesBid,
    yesAsk,
    yesMid,
    noBid,
    noAsk,
    spread,
    topYesBidNotional,
    topYesAskNotional,
  };
}

// ---------------------------------------------------------------------------
// Actionability scoring
// ---------------------------------------------------------------------------

function actionabilityScore(
  spread: number | null,
  topYesBidNotional: number,
  topYesAskNotional: number,
): "High" | "Med" | "Low" {
  if (spread === null) return "Low";
  const minDepth = Math.min(topYesBidNotional, topYesAskNotional);
  if (spread <= 1 && minDepth >= 500) return "High";
  if (spread <= 3 && minDepth >= 200) return "Med";
  return "Low";
}

// ---------------------------------------------------------------------------
// Sports detection
// ---------------------------------------------------------------------------

const SPORTS_CATEGORIES = new Set([
  "sports", "sport", "basketball", "football", "baseball", "hockey",
  "soccer", "tennis", "golf", "mma", "boxing", "racing",
]);

const SPORTS_KEYWORDS = [
  "nba", "nfl", "mlb", "nhl", "ncaa", "ncaab", "ncaaf",
  "mls", "epl", "champions league",
  "win", "wins", "champion", "playoff", "super bowl", "world series",
  "finals", "stanley cup", "game 1", "game 7",
];

const SPORTS_TICKER_PREFIXES = [
  "KXNBA", "KXNFL", "KXMLB", "KXNHL", "KXNCAA", "KXMLS",
  "KXSPRT", "KXEPL", "KXUCL", "KXMARMAD",
];

function detectSports(market: KalshiMarket): boolean {
  const cat = (market.category ?? "").toLowerCase();
  if (SPORTS_CATEGORIES.has(cat)) return true;

  const ticker = market.ticker.toUpperCase();
  if (SPORTS_TICKER_PREFIXES.some((p) => ticker.startsWith(p))) return true;

  const title = (market.title ?? "").toLowerCase();
  if (SPORTS_KEYWORDS.some((kw) => title.includes(kw))) return true;

  return false;
}

function isGameWinnerMarket(market: ProcessedMarket): boolean {
  const t = market.ticker.toUpperCase();
  const title = (market.title ?? "").toLowerCase();
  const looksLikeGame = t.includes("GAME-") || t.startsWith("KXNBAGAME") || t.startsWith("KXNFLGAME") || t.startsWith("KXNHLGAME") || t.startsWith("KXMLBGAME");
  const looksLikeWinner = title.includes("winner") || title.includes(" at ");
  return looksLikeGame || looksLikeWinner;
}

// ---------------------------------------------------------------------------
// Cross-edge analysis vs NateStacks picks
// ---------------------------------------------------------------------------

// Subset of TEAM_ALIASES (NBA + NFL + NHL — most common on Kalshi sports markets)
const TEAM_ALIASES: Record<string, string[]> = {
  // NBA
  "Atlanta Hawks": ["Hawks"],
  "Boston Celtics": ["Celtics", "Boston"],
  "Brooklyn Nets": ["Nets", "Brooklyn"],
  "Charlotte Hornets": ["Hornets"],
  "Chicago Bulls": ["Bulls"],
  "Cleveland Cavaliers": ["Cavaliers", "Cavs", "Cleveland"],
  "Dallas Mavericks": ["Mavericks", "Mavs", "Dallas"],
  "Denver Nuggets": ["Nuggets", "Denver"],
  "Detroit Pistons": ["Pistons", "Detroit"],
  "Golden State Warriors": ["Warriors", "Golden State"],
  "Houston Rockets": ["Rockets", "Houston"],
  "Indiana Pacers": ["Pacers", "Indiana"],
  "LA Clippers": ["Clippers", "Los Angeles C", "LA C"],
  "Los Angeles Lakers": ["Lakers", "Los Angeles L", "LA L"],
  "Memphis Grizzlies": ["Grizzlies", "Memphis"],
  "Miami Heat": ["Heat", "Miami"],
  "Milwaukee Bucks": ["Bucks", "Milwaukee"],
  "Minnesota Timberwolves": ["Timberwolves", "Wolves", "Minnesota"],
  "New Orleans Pelicans": ["Pelicans", "New Orleans"],
  "New York Knicks": ["Knicks", "New York"],
  "Oklahoma City Thunder": ["Thunder"],
  "Orlando Magic": ["Magic", "Orlando"],
  "Philadelphia 76ers": ["76ers", "Sixers", "Philadelphia"],
  "Phoenix Suns": ["Suns", "Phoenix"],
  "Portland Trail Blazers": ["Blazers", "Portland"],
  "Sacramento Kings": ["Sacramento"],
  "San Antonio Spurs": ["Spurs", "San Antonio"],
  "Toronto Raptors": ["Raptors", "Toronto"],
  "Utah Jazz": ["Jazz", "Utah"],
  "Washington Wizards": ["Wizards"],
  // NFL
  "Buffalo Bills": ["Bills", "Buffalo"],
  "Kansas City Chiefs": ["Chiefs"],
  "Philadelphia Eagles": ["Eagles"],
  "San Francisco 49ers": ["49ers", "Niners"],
  "Dallas Cowboys": ["Cowboys"],
  "Green Bay Packers": ["Packers"],
  "Baltimore Ravens": ["Ravens", "Baltimore"],
  "Cincinnati Bengals": ["Bengals", "Cincinnati"],
  "Pittsburgh Steelers": ["Steelers", "Pittsburgh"],
  "Denver Broncos": ["Broncos"],
  "Las Vegas Raiders": ["Raiders"],
  "Los Angeles Chargers": ["Chargers"],
  "Los Angeles Rams": ["Rams"],
  "Seattle Seahawks": ["Seahawks", "Seattle"],
  "Tampa Bay Buccaneers": ["Buccaneers", "Bucs", "Tampa"],
  "New England Patriots": ["Patriots"],
  "New York Giants": ["Giants"],
  "New York Jets": ["Jets"],
  // NHL
  "Boston Bruins": ["Bruins"],
  "Colorado Avalanche": ["Avalanche"],
  "Vegas Golden Knights": ["Golden Knights"],
  "Tampa Bay Lightning": ["Lightning"],
  "Toronto Maple Leafs": ["Maple Leafs", "Leafs"],
  "Edmonton Oilers": ["Oilers", "Edmonton"],
  "Florida Panthers": ["Panthers"],
  "New York Rangers": ["Rangers"],
  "Carolina Hurricanes": ["Hurricanes"],
  "Nashville Predators": ["Predators"],
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/\bst\.\b/g, "st")
    .replace(/\bstate\b/g, "st")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedVariants(team: string): string[] {
  const n = normalize(team);
  const parts = n.split(" ").filter(Boolean);
  const variants = new Set<string>([n]);
  if (parts.length >= 2) {
    variants.add(parts[parts.length - 1]); // mascot only
    variants.add(parts.slice(0, 2).join(" ")); // city + next token
  }
  // Very common abbrev handling
  variants.add(n.replace(/^los angeles\s+/, "la "));
  variants.add(n.replace(/^new york\s+/, "ny "));
  variants.add(n.replace(/^san antonio\s+/, "sa "));
  return [...variants].filter((v) => v.length > 0);
}

function matchTeamInQuestion(
  question: string,
  teamName: string,
): [string, string] | null {
  const normQ = normalize(question);
  const normTeam = normalize(teamName);

  const wordBoundaryMatch = (token: string): boolean => {
    if (token.length === 0) return false;
    if (token.length <= 4) {
      return new RegExp(`(?:^|\\s)${token}(?:\\s|$)`).test(normQ);
    }
    return normQ.includes(token);
  };

  for (const v of normalizedVariants(normTeam)) {
    if (wordBoundaryMatch(v)) return [teamName, v];
  }

  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    const normCanon = normalize(canonical);
    const isTarget =
      normTeam === normCanon || aliases.some((a) => normalize(a) === normTeam);
    if (!isTarget) continue;

    for (const v of normalizedVariants(normCanon)) {
      if (wordBoundaryMatch(v)) return [canonical, v];
    }
    for (const alias of aliases) {
      for (const v of normalizedVariants(alias)) {
        if (wordBoundaryMatch(v)) return [canonical, alias];
      }
    }
  }
  return null;
}

// Standard normal CDF approximation (Abramowitz & Stegun 26.2.17)
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

// Convert a point spread to moneyline win probability.
// spread is from the pick team's perspective: negative = favorite, positive = underdog.
// stdDev is the typical scoring margin std deviation for the sport.
function spreadToWinProb(spread: number, stdDev: number): number {
  return normalCDF(-spread / stdDev) * 100;
}

const SPREAD_STD_DEV: Record<string, number> = {
  NBA: 10.5,
  NCAAB: 10.0,
  NFL: 13.5,
  NCAAF: 13.0,
};

// ---------------------------------------------------------------------------
// TheRundown.io — Pinnacle moneyline snapshot for cross-edge detection
// ---------------------------------------------------------------------------

const TR_API_BASE_INGEST = "https://therundown.io/api/v2";
const TR_SPORT_IDS_INGEST = [1, 2, 3, 4, 5, 6, 10, 11, 14, 15, 16, 33];
// 1=NCAAF, 2=NFL, 3=MLB, 4=NBA, 5=NCAAB, 6=NHL, 10=MLS, 11=EPL, 14=La Liga, 15=Serie A, 16=UCL, 33=Europa

interface TRIngestParticipant {
  id: number;
  name: string;
  lines: { value: string; prices: Record<string, { price: number }> }[];
}
interface TRIngestMarket {
  market_id: number;
  participants: TRIngestParticipant[];
}
interface TRIngestEvent {
  event_id: string;
  sport_id: number;
  event_date?: string;
  teams?: { is_home?: boolean; name?: string }[];
  markets: TRIngestMarket[];
}

interface TRGameOdds {
  homeTeam: string;
  awayTeam: string;
  homeProb: number;   // 0–100, devigged Pinnacle probability
  awayProb: number;
  commenceTime: string;
  sportId: number;
}

interface PinnacleEntry {
  game: TRGameOdds;
  isHomeTeam: boolean;
}

function trAmericanToImplied(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  if (n > 0) return 100 / (n + 100);
  return Math.abs(n) / (Math.abs(n) + 100);
}

const TR_TEAM_ALIAS_MAP: Record<string, string> = {
  "borussia dortmund": "dortmund",
  "rb leipzig": "leipzig",
  "paris saint-germain": "psg",
  "paris saint germain": "psg",
  "internazionale": "inter milan",
  "fc internazionale": "inter milan",
  "ac milan": "milan",
  "atalanta bc": "atalanta",
  "newcastle united fc": "newcastle",
  "arsenal fc": "arsenal",
  "chelsea fc": "chelsea",
};

function trNormalize(raw: string): string {
  let s = raw.toLowerCase().trim().replace(/\s+(fc|sc|cf|ac|afc|fk|nk|bk|rfc)\s*$/i, "");
  s = s.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  return TR_TEAM_ALIAS_MAP[s] ?? s;
}

// Kalshi uses short abbreviations for some teams that don't match TR's full names.
// Map Kalshi subtitle (lowercased) → TR normalized school name.
const KALSHI_SUBTITLE_ALIAS: Record<string, string> = {
  // MAC / Mid-American
  "moh": "miami oh",       // Miami (OH) Redhawks
  "ohiou": "ohio",         // Ohio Bobcats (avoid collision with Ohio State)
  // Sun Belt / CUSA
  "unt": "north texas",
  "utsa": "utsa",
  "ltu": "louisiana tech",
  "mtsu": "middle tennessee",
  // Big West
  "ucsb": "uc santa barbara",
  "ucsd": "uc san diego",
  "ucr": "uc riverside",
  "ucd": "uc davis",
  // Southern / SWAC
  "sou": "southern",
  "scst": "south carolina state",
  "norf": "norfolk state",
  // Others
  "vill": "villanova",
  "conn": "uconn",
  "sju": "st johns",
  "xav": "xavier",
  "crei": "creighton",
  "hall": "seton hall",
  "prov": "providence",
  "gtwn": "georgetown",
  "gtwn": "georgetown",
  "rutg": "rutgers",
  "nw": "northwestern",
  "pur": "purdue",
  "uk": "kentucky",
  "mizz": "missouri",
  "uga": "georgia",
  "miss": "ole miss",
  "uk": "kentucky",
  "isu": "iowa state",
  "ttu": "texas tech",
  "byu": "byu",
  "hou": "houston",
  "unlv": "unlv",
  "usu": "utah state",
  "gmu": "george mason",
  "sbon": "st bonaventure",
  "lchi": "loyola chicago",
  "dav": "davidson",
  "uri": "rhode island",
  "duq": "duquesne",
  "aamu": "alabama am",
  "txso": "texas southern",
  "buff": "buffalo",
  "akr": "akron",
  "bgsu": "bowling green",
  "tol": "toledo",
  "sjsu": "san jose state",
  "bsu": "boise state",
  "csu": "colorado state",
  "sdsu": "san diego state",
  "fsu": "florida state",
  "lsu": "lsu",
  "unm": "new mexico",
  "unlv": "unlv",
  "uvu": "utah valley",
  "neu": "northeastern",
  "gccu": "grand canyon",
  "gc": "grand canyon",
  "nev": "nevada",
  "lchi": "loyola chicago",
  "for": "fordham",
  "gw": "george washington",
  "char": "charlotte",
  "tuln": "tulane",
  "umesnccu": "umes",
  "umes": "maryland eastern shore",
  "nccu": "north carolina central",
  "arpb": "arkansas pine bluff",
  "txam": "texas am",
};

function expandKalshiSubtitle(subtitle: string): string {
  const key = subtitle.toLowerCase().trim();
  return KALSHI_SUBTITLE_ALIAS[key] ?? subtitle;
}

async function loadPinnacleOdds(): Promise<Map<string, PinnacleEntry>> {
  const pinnacleMap = new Map<string, PinnacleEntry>();
  const apiKey = process.env.THERUNDOWN_API_KEY;
  if (!apiKey) {
    console.log("  [TR] No THERUNDOWN_API_KEY — skipping Pinnacle odds");
    return pinnacleMap;
  }

  const today = toEtDateStr(new Date());
  let totalGames = 0;

  for (const sportId of TR_SPORT_IDS_INGEST) {
    try {
      const url = `${TR_API_BASE_INGEST}/sports/${sportId}/events/${today}?market_ids=1&affiliate_ids=3`;
      const res = await fetch(url, {
        headers: { "X-Therundown-Key": apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`  [TR] sport=${sportId} HTTP ${res.status}`);
        continue;
      }

      const body = await res.json() as { events?: TRIngestEvent[] };
      const events = body.events ?? [];
      let sportGames = 0;

      for (const ev of events) {
        const ml = ev.markets?.find((m) => m.market_id === 1);
        if (!ml || ml.participants.length < 2) continue;

        const parts = ml.participants;
        const teamsArr = ev.teams ?? [];
        const homeEntry = teamsArr.find((t) => t.is_home === true);
        const awayEntry = teamsArr.find((t) => t.is_home === false);

        let homeP: TRIngestParticipant;
        let awayP: TRIngestParticipant;
        if (homeEntry?.name && awayEntry?.name) {
          homeP = parts.find((p) => p.name === homeEntry.name) ?? parts[0];
          awayP = parts.find((p) => p.name === awayEntry.name) ?? parts[1];
        } else {
          [homeP, awayP] = parts;
        }

        const homeML = homeP.lines?.[0]?.prices?.["3"]?.price;
        const awayML = awayP.lines?.[0]?.prices?.["3"]?.price;
        if (homeML == null || awayML == null) continue;

        const homeImpl = trAmericanToImplied(homeML);
        const awayImpl = trAmericanToImplied(awayML);
        const total = homeImpl + awayImpl;
        if (total <= 0) continue;

        const game: TRGameOdds = {
          homeTeam: homeP.name,
          awayTeam: awayP.name,
          homeProb: (homeImpl / total) * 100,
          awayProb: (awayImpl / total) * 100,
          commenceTime: ev.event_date ?? "",
          sportId,
        };

        const indexTeam = (teamName: string, isHome: boolean): void => {
          const norm = trNormalize(teamName);
          const words = norm.split(" ");
          const last = words.at(-1) ?? "";
          const first2 = words.slice(0, 2).join(" ");
          // School name without mascot (e.g. "Massachusetts Minutemen" → "massachusetts")
          const schoolName = words.length > 1 ? words.slice(0, -1).join(" ") : norm;
          const rawKeys = new Set<string>([norm, last, first2, schoolName, teamName.toLowerCase()]);
          // Also index "State" variants as "St" (Kalshi abbreviates e.g. "Ohio St." → "ohio st")
          if (norm.includes("state")) {
            rawKeys.add(norm.replace(/\bstate\b/g, "st"));
            rawKeys.add(schoolName.replace(/\bstate\b/g, "st"));
          }
          // Key as "name:sportId" to prevent cross-sport collisions (e.g. Minnesota NBA vs NCAAB)
          for (const key of rawKeys) {
            if (key.length > 2) pinnacleMap.set(`${key}:${sportId}`, { game, isHomeTeam: isHome });
          }
        };
        indexTeam(homeP.name, true);
        indexTeam(awayP.name, false);
        sportGames++;
      }

      if (sportGames > 0) {
        console.log(`  [TR] sport=${sportId}: ${sportGames} games`);
        totalGames += sportGames;
      }
    } catch (err) {
      console.warn(`  [TR] sport=${sportId} error: ${(err as Error).message}`);
    }
  }

  console.log(`  [TR] Pinnacle loaded: ${totalGames} games | ${pinnacleMap.size} team variants`);
  return pinnacleMap;
}

function findCrossEdgeFromPinnacle(
  market: ProcessedMarket,
  pinnacleMap: Map<string, PinnacleEntry>,
  injuries: Record<string, InjuryRecord[]>,
  misses?: CrossEdgeMiss[],
): CrossEdge | undefined {
  if (market.yesMid === null || pinnacleMap.size === 0) return undefined;

  // Identify YES team from subtitle (yes_sub_title) first, then parse title
  let yesTeamRaw = market.subtitle?.trim() ?? "";
  if (!yesTeamRaw || yesTeamRaw.length > 50) {
    const m = market.title.match(/will (.+?) (?:beat|defeat|win)/i)
           ?? market.title.match(/^(.+?) (?:at|vs\.?|@) /i);
    yesTeamRaw = m?.[1]?.trim() ?? "";
  }
  // Expand known Kalshi subtitle abbreviations (e.g. "MOH" → "miami oh")
  yesTeamRaw = expandKalshiSubtitle(yesTeamRaw);
  if (!yesTeamRaw) return undefined;

  // Determine expected TR sport ID from Kalshi ticker prefix — prevents cross-sport name collisions
  const KALSHI_PREFIX_TO_SPORT: Record<string, number> = {
    KXNCAAMBGAME: 5, KXNCAAWBGAME: 5,
    KXNBAGAME: 4,
    KXNHLGAME: 6,
    KXMLBGAME: 3, KXMLBSTGAME: 3,  // regular + spring training
    KXNFLGAME: 2,
    KXMLSSTGAME: 10,
  };
  const tickerUpper = market.ticker.toUpperCase();
  const expectedSportId = Object.entries(KALSHI_PREFIX_TO_SPORT)
    .find(([pfx]) => tickerUpper.startsWith(pfx))?.[1];

  // Try normalized variants against pinnacleMap (keyed as "name:sportId")
  const norm = trNormalize(yesTeamRaw);
  const words = norm.split(" ");
  const last = words.at(-1) ?? "";
  const first2 = words.slice(0, 2).join(" ");
  const schoolName = words.length > 1 ? words.slice(0, -1).join(" ") : norm;
  const rawCandidates = [norm, last, first2, schoolName, yesTeamRaw.toLowerCase()];
  // Handle Kalshi abbreviation "St." → pinnacle uses "State" (we index both; try expanded form too)
  if (norm.includes(" st") && !norm.includes("state")) {
    rawCandidates.push(norm.replace(/\bst\b/g, "state"));
    rawCandidates.push(schoolName.replace(/\bst\b/g, "state"));
  }

  // Build keyed candidates — prefer sport-specific key, fall back to any sport
  const sportIds = expectedSportId !== undefined
    ? [expectedSportId]
    : [4, 5, 6, 3, 2, 10, 11, 14, 15];
  const candidates: string[] = [];
  for (const sid of sportIds) {
    for (const raw of rawCandidates) {
      if (raw.length > 2) candidates.push(`${raw}:${sid}`);
    }
  }

  let entry: PinnacleEntry | undefined;
  for (const key of candidates) {
    entry = pinnacleMap.get(key);
    if (entry) break;
  }

  if (!entry) {
    misses?.push({
      marketTicker: market.ticker,
      marketTitle: market.title,
      pickTeam: yesTeamRaw,
      opponent: "",
      reason: "pick_unmatched",
    });
    return undefined;
  }

  const { game, isHomeTeam } = entry;

  // Verify opponent also appears in the Kalshi market title — prevents bracket mismatches
  // (e.g. Pinnacle prices "South Carolina at Oklahoma" but Kalshi has "Oklahoma at Texas A&M")
  const opponent = isHomeTeam ? game.awayTeam : game.homeTeam;
  const opponentNorm = trNormalize(opponent);
  const opponentWords = opponentNorm.split(" ");
  const opponentSchool = opponentWords.length > 1 ? opponentWords.slice(0, -1).join(" ") : opponentNorm;
  const titleNorm = trNormalize(market.title);
  const opponentInTitle = [opponentNorm, opponentSchool, opponentWords.at(-1) ?? ""]
    .some(w => w.length > 2 && titleNorm.includes(w));
  if (!opponentInTitle) {
    misses?.push({
      marketTicker: market.ticker,
      marketTitle: market.title,
      pickTeam: yesTeamRaw,
      opponent,
      reason: "bracket_mismatch",
    });
    return undefined;
  }

  const pinnacleProb = isHomeTeam ? game.homeProb : game.awayProb;
  const kalshiImplied = market.yesMid;
  const gap = pinnacleProb - kalshiImplied;

  if (Math.abs(gap) < 5) {
    misses?.push({
      marketTicker: market.ticker,
      marketTitle: market.title,
      pickTeam: yesTeamRaw,
      opponent,
      reason: "below_threshold",
      gap: Math.round(gap * 10) / 10,
    });
    return undefined;
  }

  // T-minus until game start
  let tMinusMinutes: number | undefined;
  if (game.commenceTime) {
    const diffMin = (new Date(game.commenceTime).getTime() - Date.now()) / 60_000;
    if (diffMin > 0 && diffMin < 1440) tMinusMinutes = Math.round(diffMin);
  }

  // League for injury context
  const sportLeague: Record<number, string> = { 2: "NFL", 3: "MLB", 4: "NBA", 6: "NHL" };
  const league = sportLeague[game.sportId] ?? "";

  console.log(
    `  [TR cross-edge] "${market.title.slice(0, 50)}" ` +
    `yes="${yesTeamRaw}" pinnacle=${pinnacleProb.toFixed(1)}% kalshi=${kalshiImplied.toFixed(1)}% gap=${gap.toFixed(1)}%`,
  );

  return {
    pickTeam: yesTeamRaw,
    opponent,
    modelConfidence: Math.round(pinnacleProb * 10) / 10,
    kalshiImplied: Math.round(kalshiImplied * 10) / 10,
    gap: Math.round(gap * 10) / 10,
    direction: gap > 0 ? "model-higher" : "model-lower",
    matchedVia: `Pinnacle (devigged) sport=${game.sportId} ${isHomeTeam ? "home" : "away"}="${norm}"`,
    gameDate: game.commenceTime,
    tMinusMinutes,
    injuryContext: league ? injuryContext(yesTeamRaw, opponent, injuries, league) : undefined,
  };
}

function loadBestBets(root: string): BestBet[] {
  const p = path.join(root, "data", "processed", "latest-summary.json");
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { bestBets?: BestBet[] };
    return data.bestBets ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Injury loading
// ---------------------------------------------------------------------------

interface InjuryRecord {
  player: string;
  team: string;
  position: string;
  status: string;
  injuryType?: string;
}

function loadInjuries(root: string): Record<"nba" | "nfl", InjuryRecord[]> {
  const result: Record<"nba" | "nfl", InjuryRecord[]> = { nba: [], nfl: [] };
  for (const sport of ["nba", "nfl"] as const) {
    const p = path.join(root, "data", "processed", `injuries-${sport}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
      // Handle both array format (legacy) and {players: [...]} format (new)
      const players = Array.isArray(raw)
        ? (raw as InjuryRecord[])
        : (raw as { players?: InjuryRecord[] }).players ?? [];
      result[sport] = players;
    } catch { /* ignore corrupt file */ }
  }
  return result;
}

function injuryContext(
  pickTeam: string,
  opponent: string,
  injuries: Record<string, InjuryRecord[]>,
  league: string,
): CrossEdge["injuryContext"] {
  const leagueKey = league.toLowerCase() as "nba" | "nfl";
  const leagueInjuries = injuries[leagueKey] ?? [];
  if (!leagueInjuries.length) return undefined;

  const STAR_POSITIONS: Record<string, string[]> = {
    nba: ["PG", "SG", "SF", "PF", "C"],
    nfl: ["QB", "RB", "WR", "TE"],
  };
  const starPos = STAR_POSITIONS[leagueKey] ?? [];
  const criticalStatuses = ["OUT", "DOUBTFUL"];

  function isStar(inj: InjuryRecord): boolean {
    const pos = (inj.position ?? "").toUpperCase();
    const status = (inj.status ?? "").toUpperCase();
    return (
      starPos.some((p) => pos.includes(p)) &&
      criticalStatuses.some((s) => status.includes(s))
    );
  }

  function teamMatch(inj: InjuryRecord, teamName: string): boolean {
    const injTeam = inj.team.toLowerCase();
    const norm = teamName.toLowerCase();
    // Check last word of team name (e.g. "Thunder" in "Oklahoma City Thunder")
    const lastWord = norm.split(/\s+/).at(-1) ?? norm;
    return injTeam.includes(norm) || norm.includes(injTeam) || injTeam.includes(lastWord);
  }

  const pickStars = leagueInjuries
    .filter((inj) => teamMatch(inj, pickTeam) && isStar(inj))
    .map((inj) => inj.player);

  const oppStars = leagueInjuries
    .filter((inj) => teamMatch(inj, opponent) && isStar(inj))
    .map((inj) => inj.player);

  if (!pickStars.length && !oppStars.length) return undefined;

  return {
    pickInjuredStars: pickStars,
    oppInjuredStars: oppStars,
  };
}

// ---------------------------------------------------------------------------
// Price history & movement tracking
// ---------------------------------------------------------------------------

interface PriceSnapshot {
  ts: number;    // Unix ms
  yesMid: number;
}

type PriceHistory = Record<string, PriceSnapshot[]>;

const MAX_HISTORY_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_HISTORY_SNAPSHOTS = 72;

function loadPriceHistory(root: string): PriceHistory {
  const p = path.join(root, "data", "processed", "kalshi-price-history.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8")) as PriceHistory;
  } catch { /* ok */ }
  return {};
}

function savePriceHistory(root: string, history: PriceHistory): void {
  const p = path.join(root, "data", "processed", "kalshi-price-history.json");
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(history), "utf-8");
  try {
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(p); } catch { /* ok */ }
    fs.renameSync(tmp, p);
  }
}

function updatePriceHistory(
  processed: ProcessedMarket[],
  history: PriceHistory,
): void {
  const now = Date.now();
  const cutoff = now - MAX_HISTORY_AGE_MS;

  const activeTickers = new Set(processed.map((m) => m.ticker));

  for (const market of processed) {
    if (market.yesMid === null) continue;
    if (!history[market.ticker]) history[market.ticker] = [];

    history[market.ticker].push({ ts: now, yesMid: market.yesMid });

    // Prune old + cap at max snapshots
    history[market.ticker] = history[market.ticker]
      .filter((s) => s.ts > cutoff)
      .slice(-MAX_HISTORY_SNAPSHOTS);
  }

  // Remove tickers no longer in market list
  for (const ticker of Object.keys(history)) {
    if (!activeTickers.has(ticker)) delete history[ticker];
  }
}

function computeMovement(
  ticker: string,
  modelYesPct: number,
  history: PriceHistory,
): CrossEdge["movementSignal"] {
  const snapshots = history[ticker];
  if (!snapshots || snapshots.length < 2) return undefined;

  const sorted = [...snapshots].sort((a, b) => a.ts - b.ts);
  const latest = sorted[sorted.length - 1];
  const now = Date.now();

  const ago30 = now - 30 * 60 * 1000;
  const snap30 = sorted.filter((s) => s.ts <= ago30).at(-1) ?? sorted[0];

  const delta30m = snap30 ? latest.yesMid - snap30.yesMid : null;

  const timeSpan30m = snap30 ? (latest.ts - snap30.ts) / 60_000 : 0;
  const velocity =
    delta30m !== null && timeSpan30m > 0 ? Math.abs(delta30m) / timeSpan30m : 0;

  // movingToward: if model says YES > current mid, we want the price to rise
  const modelHigher = modelYesPct > latest.yesMid;
  const movingToward = modelHigher ? (delta30m ?? 0) > 0 : (delta30m ?? 0) < 0;

  return { delta30m, movingToward, velocity: Math.round(velocity * 100) / 100 };
}

// ---------------------------------------------------------------------------
// March Madness tournament edge
// ---------------------------------------------------------------------------

// Ticker suffix → ESPN full team name (exact-match first in findNcaabRating, then fuzzy)
// Calibrated against live KXMARMAD-26-* tickers observed on Kalshi (2026-03 season)
const MARMAD_TICKER_TO_TEAM: Record<string, string> = {
  // Kalshi short tickers (live MARMAD-26 markets) — mapped to ESPN full team names
  "DUKE":    "Duke Blue Devils",
  "MICH":    "Michigan Wolverines",
  "FLA":     "Florida Gators",
  "ARIZ":    "Arizona Wildcats",
  "TTU":     "Texas Tech Red Raiders",
  "HOU":     "Houston Cougars",
  "ILL":     "Illinois Fighting Illini",
  "ISU":     "Iowa State Cyclones",
  "KU":      "Kansas Jayhawks",
  "WIS":     "Wisconsin Badgers",
  "MSU":     "Michigan State Spartans",
  "GONZ":    "Gonzaga Bulldogs",
  "TENN":    "Tennessee Volunteers",
  "BYU":     "BYU Cougars",
  "UNC":     "North Carolina Tar Heels",
  "PUR":     "Purdue Boilermakers",
  "NEB":     "Nebraska Cornhuskers",
  "SJU":     "St. John's Red Storm",
  "ARK":     "Arkansas Razorbacks",
  "ALA":     "Alabama Crimson Tide",
  "UVA":     "Virginia Cavaliers",
  "NCST":    "NC State Wolfpack",
  "VAN":     "Vanderbilt Commodores",
  "LOU":     "Louisville Cardinals",
  "UK":      "Kentucky Wildcats",
  "IOWA":    "Iowa Hawkeyes",
  "BAY":     "Baylor Bears",
  "AUB":     "Auburn Tigers",
  "UCLA":    "UCLA Bruins",
  "IND":     "Indiana Hoosiers",
  "CONN":    "UConn Huskies",
  // Alternate / legacy spellings
  "UCONN":       "UConn Huskies",
  "MICHIGAN":    "Michigan Wolverines",
  "MICHIGAN-ST": "Michigan State Spartans",
  "OHIO-ST":     "Ohio State Buckeyes",   "OSU": "Ohio State Buckeyes",
  "INDIANA":     "Indiana Hoosiers",
  "PURDUE":      "Purdue Boilermakers",
  "ILLINOIS":    "Illinois Fighting Illini",
  "MARYLAND":    "Maryland Terrapins",
  "NEBRASKA":    "Nebraska Cornhuskers",
  "WISC":        "Wisconsin Badgers",
  "KANSAS":      "Kansas Jayhawks",
  "IOWA-ST":     "Iowa State Cyclones",
  "BAYLOR":      "Baylor Bears",
  "HOUSTON":     "Houston Cougars",
  "TEXAS-TECH":  "Texas Tech Red Raiders",
  "KENTUCKY":    "Kentucky Wildcats",
  "TENNESSEE":   "Tennessee Volunteers",
  "AUBURN":      "Auburn Tigers",
  "ALABAMA":     "Alabama Crimson Tide",
  "FLORIDA":     "Florida Gators",
  "ARKANSAS":    "Arkansas Razorbacks",
  "VANDERBILT":  "Vanderbilt Commodores",
  "ARIZONA":     "Arizona Wildcats",
  "GONZAGA":     "Gonzaga Bulldogs",   "ZAGS": "Gonzaga Bulldogs",
  "FLST":        "Florida State Seminoles",
  "CAROLINAS":   "South Carolina Gamecocks",
  "SDSU":        "San Diego State Aztecs",
};

function getTeamFromMarmadTicker(ticker: string): string | null {
  // "KXMARMAD-26-DUKE" → suffix "DUKE"
  const parts = ticker.toUpperCase().split("-");
  // Skip "KXMARMAD" and the year part (2 digits)
  let suffixStart = 1;
  for (let i = 1; i < parts.length; i++) {
    if (/^\d{2}$/.test(parts[i])) { suffixStart = i + 1; break; }
  }
  const suffix = parts.slice(suffixStart).join("-");
  return MARMAD_TICKER_TO_TEAM[suffix] ?? null;
}

interface TournamentRatings {
  fetchedAt?: string;
  teams: Record<string, number | null>;
}

function loadTournamentRatings(root: string): TournamentRatings | null {
  const p = path.join(root, "data", "processed", "ncaa-tournament-ratings.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as TournamentRatings;
  } catch { return null; }
}

function findNcaabRating(teamName: string, ratings: Record<string, number | null>): number | null {
  if (ratings[teamName] !== undefined) return ratings[teamName];

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const normTarget = norm(teamName);
  const targetLast = normTarget.split(/\s+/).at(-1) ?? normTarget;
  const targetFirst = normTarget.split(/\s+/)[0] ?? normTarget;

  for (const [key, val] of Object.entries(ratings)) {
    const normKey = norm(key);
    if (normKey === normTarget) return val;
    if (normKey.includes(normTarget) || normTarget.includes(normKey)) return val;
    const keyLast = normKey.split(/\s+/).at(-1) ?? normKey;
    if (keyLast === targetLast && targetLast.length > 3) return val;
    const keyFirst = normKey.split(/\s+/)[0] ?? normKey;
    if (keyFirst === targetFirst && targetFirst.length > 4) return val;
  }
  return null;
}

function findTournamentEdge(
  market: ProcessedMarket,
  ratings: TournamentRatings,
  avgFieldSrs: number,
): TournamentEdge | undefined {
  if (market.yesMid === null) return undefined;

  const teamName = getTeamFromMarmadTicker(market.ticker);
  if (!teamName) return undefined;

  const teamSrs = findNcaabRating(teamName, ratings.teams);
  if (teamSrs == null) return undefined;

  // singleGameWinPct: probability this team beats the average MARMAD field team.
  // sigma=15 reflects that NCAA tournament outcomes are noisier than raw SRS suggests.
  // 6 rounds required to win the championship.
  const singleGameWinPct = normalCDF((teamSrs - avgFieldSrs) / 15.0) * 100;
  // Raw 6-round championship probability (not yet normalized)
  const modelChampionPct = Math.pow(singleGameWinPct / 100, 6) * 100;

  const gap = modelChampionPct - market.yesMid;
  if (Math.abs(gap) < 5) return undefined;

  console.log(
    `  [marmad] "${market.ticker}" team="${teamName}" srs=${teamSrs.toFixed(1)} ` +
    `model=${modelChampionPct.toFixed(1)}% kalshi=${market.yesMid.toFixed(1)}% gap=${gap.toFixed(1)}%`,
  );

  return {
    team: teamName,
    teamSrs: Math.round(teamSrs * 10) / 10,
    avgFieldSrs: Math.round(avgFieldSrs * 10) / 10,
    modelChampionPct: Math.round(modelChampionPct * 10) / 10,
    kalshiImplied: Math.round(market.yesMid * 10) / 10,
    gap: Math.round(gap * 10) / 10,
    direction: gap > 0 ? "model-higher" : "model-lower",
  };
}

function findCrossEdge(
  market: ProcessedMarket,
  bestBets: BestBet[],
  injuries: Record<string, InjuryRecord[]>,
  misses?: CrossEdgeMiss[],
): CrossEdge | undefined {
  if (market.yesMid === null) return undefined;

  for (const bet of bestBets) {
    const pickMatch = matchTeamInQuestion(market.title, bet.pickTeam);
    if (!pickMatch) {
      misses?.push({ marketTicker: market.ticker, marketTitle: market.title, pickTeam: bet.pickTeam, opponent: bet.opponent, reason: "pick_unmatched" });
      continue;
    }
    const oppMatch = matchTeamInQuestion(market.title, bet.opponent);
    if (!oppMatch) {
      misses?.push({ marketTicker: market.ticker, marketTitle: market.title, pickTeam: bet.pickTeam, opponent: bet.opponent, reason: "opp_unmatched" });
      continue;
    }

    // Optional same-ET-day check
    if (market.closeTime && bet.gameDate) {
      try {
        const closeEtDate = toEtDateStr(new Date(market.closeTime));
        const betEtDate = toEtDateStr(new Date(bet.gameDate));
        // Kalshi markets close at or after game end, so close date >= game date is fine
        if (closeEtDate < betEtDate) {
          misses?.push({ marketTicker: market.ticker, marketTitle: market.title, pickTeam: bet.pickTeam, opponent: bet.opponent, reason: "date_mismatch" });
          continue;
        }
      } catch {
        // skip date filter on parse failure
      }
    }

    const kalshiImplied = market.yesMid;

    // -----------------------------------------------------------------------
    // Soccer 3-way market: use subtitle matching and confidence directly.
    // Soccer markets have 3 possible outcomes (home / draw / away), each as
    // its own Kalshi market with a distinct subtitle (e.g. "Barcelona", "Tie").
    // The standard pickIsFavorite / pickIsYes logic breaks for these markets,
    // so we bypass it entirely when a subtitle is present.
    // -----------------------------------------------------------------------
    if (bet.subtitle !== undefined) {
      const subMatch = matchTeamInQuestion(market.subtitle ?? "", bet.subtitle);
      if (!subMatch) {
        misses?.push({ marketTicker: market.ticker, marketTitle: market.title, pickTeam: bet.pickTeam, opponent: bet.opponent, reason: "subtitle_unmatched" });
        continue;
      }

      // Soccer: confidence IS the fair probability for this specific outcome
      const modelYesProb = bet.confidence;
      const gap = modelYesProb - kalshiImplied;
      if (Math.abs(gap) < 5) {
        misses?.push({ marketTicker: market.ticker, marketTitle: market.title, pickTeam: bet.pickTeam, opponent: bet.opponent, reason: "below_threshold", gap: Math.round(gap * 10) / 10 });
        continue;
      }

      let tMinusMinutes: number | undefined;
      if (bet.gameDate) {
        const diffMin = (new Date(bet.gameDate).getTime() - Date.now()) / 60_000;
        if (diffMin > 0 && diffMin < 1440) tMinusMinutes = Math.round(diffMin);
      }

      console.log(
        `  [cross-edge/soccer] "${market.title.slice(0, 50)}…" ` +
          `subtitle="${subMatch[1]}" pick="${bet.pickTeam}" gap=${gap.toFixed(1)}%`,
      );

      return {
        pickTeam: bet.pickTeam,
        opponent: bet.opponent,
        modelConfidence: Math.round(modelYesProb * 10) / 10,
        kalshiImplied: Math.round(kalshiImplied * 10) / 10,
        gap: Math.round(gap * 10) / 10,
        direction: gap > 0 ? "model-higher" : "model-lower",
        matchedVia: `soccer subtitle="${subMatch[1]}" pick="${pickMatch[1]}" opp="${oppMatch[1]}"`,
        gameDate: bet.gameDate,
        tMinusMinutes,
        injuryContext: injuryContext(bet.pickTeam, bet.opponent, injuries, bet.league),
        // movementSignal is set after findCrossEdge returns (needs price history)
      };
    }

    // Compute model's pick-team win probability from the spread.
    // ATS confidence is NOT a moneyline probability — a team at -8.5 implies ~79%
    // win probability, not the 55-60% confidence the ATS model might express.
    // Use modelSpread (or spread) with sport-specific scoring margin std dev.
    const stdDev = SPREAD_STD_DEV[bet.league] ?? 10.5;
    const rawSpread = bet.modelSpread ?? bet.spread;
    // modelPickProb: moneyline win probability (0-100) for the pick team
    const modelPickProb =
      rawSpread !== undefined ? spreadToWinProb(rawSpread, stdDev) : bet.confidence;

    // Determine if the pickTeam is the YES outcome of this market.
    // Both mirror markets share the same title; use spread sign + yesMid to identify.
    // If pick is the favorite (spread < 0), the market with yesMid > 50 is the favorite's market.
    const pickIsFavorite = (bet.spread ?? 0) <= 0;
    const pickIsYes = pickIsFavorite ? market.yesMid > 50 : market.yesMid < 50;
    const modelYesProb = pickIsYes ? modelPickProb : 100 - modelPickProb;

    const gap = modelYesProb - kalshiImplied;
    if (Math.abs(gap) < 5) {
      misses?.push({ marketTicker: market.ticker, marketTitle: market.title, pickTeam: bet.pickTeam, opponent: bet.opponent, reason: "below_threshold", gap: Math.round(gap * 10) / 10 });
      continue;
    }

    let tMinusMinutes: number | undefined;
    if (bet.gameDate) {
      const diffMin = (new Date(bet.gameDate).getTime() - Date.now()) / 60_000;
      if (diffMin > 0 && diffMin < 1440) tMinusMinutes = Math.round(diffMin);
    }

    console.log(
      `  [cross-edge] "${market.title.slice(0, 50)}…" ` +
        `pick="${pickMatch[1]}" opp="${oppMatch[1]}" gap=${gap.toFixed(1)}%`,
    );

    return {
      pickTeam: bet.pickTeam,
      opponent: bet.opponent,
      modelConfidence: Math.round(modelPickProb * 10) / 10,
      kalshiImplied: Math.round(kalshiImplied * 10) / 10,
      gap: Math.round(gap * 10) / 10,
      direction: gap > 0 ? "model-higher" : "model-lower",
      matchedVia: `"${pickMatch[1]}" + "${oppMatch[1]}" (YES=${pickIsYes ? "pick" : "opp"})`,
      gameDate: bet.gameDate,
      tMinusMinutes,
      injuryContext: injuryContext(bet.pickTeam, bet.opponent, injuries, bet.league),
      // movementSignal is set after findCrossEdge returns (needs price history)
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Assemble ProcessedMarket
// ---------------------------------------------------------------------------

function processMarket(
  raw: KalshiMarket,
  ob: KalshiOrderbook | null,
): ProcessedMarket {
  const book = synthesizeBook(ob);
  const actionability = actionabilityScore(
    book.spread,
    book.topYesBidNotional,
    book.topYesAskNotional,
  );

  // Fall back to market-list bid/ask when no orderbook (less accurate)
  // API returns either cents (yes_bid) or dollar strings (yes_bid_dollars) depending on endpoint
  const parseDollars = (v: string | undefined): number | null =>
    v !== undefined ? Math.round(parseFloat(v) * 100) : null;
  const yesBid = book.yesBid ?? (raw.yes_bid !== undefined ? raw.yes_bid : parseDollars(raw.yes_bid_dollars));
  const yesAsk = book.yesAsk ?? (raw.yes_ask !== undefined ? raw.yes_ask : parseDollars(raw.yes_ask_dollars));
  const noBid = book.noBid ?? (raw.no_bid !== undefined ? raw.no_bid : parseDollars(raw.no_bid_dollars));
  const noAsk = book.noAsk ?? (raw.no_ask !== undefined ? raw.no_ask : parseDollars(raw.no_ask_dollars));
  const spread = book.spread;

  let yesMid = book.yesMid;
  if (yesMid === null && raw.last_price !== undefined) yesMid = raw.last_price;
  if (yesMid === null && raw.last_price_dollars !== undefined) yesMid = parseDollars(raw.last_price_dollars);

  const closeTime = raw.close_time ?? raw.expiration_time ?? "";

  return {
    ticker: raw.ticker,
    title: raw.title ?? raw.ticker,
    subtitle: raw.yes_sub_title ?? "",
    category: raw.category ?? "general",
    eventTicker: raw.event_ticker,
    yesBid,
    yesAsk,
    yesMid,
    noBid,
    noAsk,
    spread,
    topYesBidNotional: book.topYesBidNotional,
    topYesAskNotional: book.topYesAskNotional,
    impliedProbYes: yesMid !== null ? Math.round(yesMid * 10) / 10 : null,
    volume: raw.volume ?? raw.volume_24h ?? 0,
    openInterest: (raw.open_interest ?? 0) || parseFloat(raw.open_interest_fp ?? "0"),
    liquidity: raw.liquidity ?? ((raw.open_interest ?? 0) || parseFloat(raw.open_interest_fp ?? "0")),
    status: raw.status,
    closeTime,
    actionability,
    isSports: detectSports(raw),
  };
}

// ---------------------------------------------------------------------------
// Atomic AGENTS.md update (between <!-- MARKETS-START --> and <!-- MARKETS-END -->)
// ---------------------------------------------------------------------------

function updateAgentsMd(filePath: string, block: string): void {
  if (!fs.existsSync(filePath)) {
    console.warn(`  [agents.md] Not found: ${filePath} — skipping`);
    return;
  }
  if (block.trim().length === 0) {
    console.warn("  [agents.md] Empty block — skipping");
    return;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const START = "<!-- MARKETS-START -->";
  const END = "<!-- MARKETS-END -->";
  const si = content.indexOf(START);
  const ei = content.indexOf(END);
  if (si === -1 || ei === -1) {
    console.warn("  [agents.md] Markers not found — skipping");
    return;
  }

  const updated =
    content.slice(0, si + START.length) +
    "\n" +
    block +
    "\n" +
    content.slice(ei);

  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, updated, "utf-8");
  fs.renameSync(tmp, filePath);
  console.log(`  [agents.md] Updated: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Format output blocks
// ---------------------------------------------------------------------------

function fmtCents(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v)}¢`;
}

function fmtNotional(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  return `$${usd.toFixed(0)}`;
}

function fmtEtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function fmtTMinus(targetIso: string, now: Date): string {
  const target = new Date(targetIso);
  if (Number.isNaN(target.getTime())) return "—";
  const mins = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (mins <= 0) return "started/closed";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function parseTickerKickoffEt(ticker: string): { label: string; sortKey: string } | null {
  // Example: KXNLGAME-26MAR091445... => 3/9 2:45 PM ET
  const m = ticker.toUpperCase().match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{4})/);
  if (!m) return null;
  const [, yy, mon, dd, hhmm] = m;
  const monthMap: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const month = monthMap[mon];
  if (!month) return null;

  const hour24 = Number(hhmm.slice(0, 2));
  const minute = hhmm.slice(2, 4);
  if (!Number.isFinite(hour24) || hour24 < 0 || hour24 > 23) return null;

  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 >= 12 ? "PM" : "AM";
  const label = `${Number(month)}/${Number(dd)} ${hour12}:${minute} ${ampm} ET`;
  const sortKey = `20${yy}${month}${dd}${hhmm}`;
  return { label, sortKey };
}

function formatAgentsMdBlock(
  markets: ProcessedMarket[],
  crossEdgeMarkets: ProcessedMarket[],
  fetchedAt: Date,
  dataAgeMinutes: number,
): string {
  const timeStr = etDisplayStr(fetchedAt);
  const sportsCount = markets.filter((m) => m.isSports).length;

  const top10 = markets.slice(0, 10);
  const sportsNotInTop10 = markets
    .filter((m) => m.isSports && !top10.some((t) => t.ticker === m.ticker))
    .slice(0, 8);

  const lines: string[] = [
    `# Kalshi Markets Snapshot — ${timeStr} ET`,
    `_Last refreshed: ${timeStr} ET | data_age_minutes: ${dataAgeMinutes} | ${markets.length} markets | ${sportsCount} sports | ${crossEdgeMarkets.length} cross-edge alerts_`,
    "",
    "## Top 10 by Liquidity / Open Interest",
    "",
  ];

  for (let i = 0; i < top10.length; i++) {
    const m = top10[i];
    const implStr = m.impliedProbYes !== null ? `${m.impliedProbYes}%` : "—";
    const spreadStr = m.spread !== null ? `${Math.round(m.spread)}¢` : "incomplete book";
    const depthStr =
      m.spread !== null
        ? `bid ${fmtNotional(m.topYesBidNotional)} / ask ${fmtNotional(m.topYesAskNotional)}`
        : "$0";
    const closeStr = m.closeTime
      ? new Date(m.closeTime).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })
      : "Unknown";

    lines.push(`**${i + 1}. ${m.title || m.ticker}**`);
    lines.push(`YES bid/ask: ${fmtCents(m.yesBid)} / ${fmtCents(m.yesAsk)} → Implied: ${implStr}`);
    lines.push(
      `Spread: ${spreadStr} | Depth: ${depthStr} | Actionability: ${m.actionability}`,
    );
    lines.push(
      `OI: ${m.openInterest.toLocaleString()} | Vol: ${m.volume.toLocaleString()} | Closes: ${closeStr}`,
    );
    lines.push("");
  }

  if (sportsNotInTop10.length > 0) {
    lines.push("## Sports Markets (outside Top 10)");
    lines.push("");
    for (const m of sportsNotInTop10) {
      const implStr = m.impliedProbYes !== null ? `${m.impliedProbYes}%` : "—";
      lines.push(
        `- **${m.ticker}** ${m.title} — YES bid ${fmtCents(m.yesBid)} / ask ${fmtCents(m.yesAsk)} | Implied ${implStr} | ${m.actionability}`,
      );
    }
    lines.push("");
  }

  const now = fetchedAt;
  const upcomingSports = markets
    .filter((m) => m.isSports)
    .map((m) => {
      const kickoff = parseTickerKickoffEt(m.ticker);
      const closeTs = m.closeTime ? new Date(m.closeTime).getTime() : Number.POSITIVE_INFINITY;
      return { m, kickoff, closeTs };
    })
    .filter((x) => x.kickoff || Number.isFinite(x.closeTs))
    .sort((a, b) => {
      // Prefer explicit kickoff from ticker for game markets
      if (a.kickoff && b.kickoff) return a.kickoff.sortKey.localeCompare(b.kickoff.sortKey);
      if (a.kickoff && !b.kickoff) return -1;
      if (!a.kickoff && b.kickoff) return 1;
      return a.closeTs - b.closeTs;
    })
    .slice(0, 20);

  if (upcomingSports.length > 0) {
    lines.push("## Upcoming Sports Schedule (ET)");
    lines.push("_Coverage helper across all sports; kickoff from ticker when available, else market close time._");
    lines.push("");
    for (const { m, kickoff } of upcomingSports) {
      const when = kickoff
        ? `Starts ${kickoff.label}`
        : `Closes ${fmtEtDateTime(m.closeTime)} ET`;
      const tMinus = kickoff
        ? (() => {
            const y = Number(kickoff.sortKey.slice(0, 4));
            const mo = Number(kickoff.sortKey.slice(4, 6));
            const d = Number(kickoff.sortKey.slice(6, 8));
            const h = Number(kickoff.sortKey.slice(8, 10));
            const mi = Number(kickoff.sortKey.slice(10, 12));
            const kickoffLocal = new Date(y, mo - 1, d, h, mi, 0);
            const mins = Math.round((kickoffLocal.getTime() - now.getTime()) / 60_000);
            if (mins <= 0) return "started/closed";
            const hh = Math.floor(mins / 60);
            const mm = mins % 60;
            return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
          })()
        : (m.closeTime ? fmtTMinus(m.closeTime, now) : "—");
      lines.push(`- **${m.ticker}** ${m.title} — ${when} | T-minus ${tMinus} | ${m.actionability}`);
    }
    lines.push("");
  }

  lines.push("## Cross-Book Edge Alerts");
  lines.push(
    "_Markets where Kalshi implied probability diverges ≥5% from Pinnacle (devigged) or NateStacks model_",
  );
  lines.push("");

  if (crossEdgeMarkets.length === 0) {
    lines.push("_No significant divergences found (≥5% threshold)._");
    lines.push("");
  } else {
    for (const m of crossEdgeMarkets) {
      const ce = m.crossEdge!;
      const gapStr = ce.gap > 0 ? `+${ce.gap}%` : `${ce.gap}%`;
      const dirNote =
        ce.direction === "model-higher"
          ? `model HIGHER — Kalshi may be underpricing ${ce.pickTeam}`
          : `model LOWER — Kalshi may be overpricing ${ce.pickTeam}`;

      const isPinnacle = ce.matchedVia?.startsWith("Pinnacle");
      lines.push(`**${m.title}** [${m.ticker}]`);
      lines.push(`- Kalshi: YES mid ${fmtCents(m.yesMid)} → Implied ${m.impliedProbYes}%`);
      lines.push(`- ${isPinnacle ? "Pinnacle (devigged)" : "NateStacks model"}: ${ce.modelConfidence}% ${isPinnacle ? "fair probability" : "confidence"}`);
      lines.push(`- Gap: ${gapStr} (${dirNote})`);
      lines.push(`- Matched via: ${ce.matchedVia}`);
      if (ce.tMinusMinutes !== undefined) {
        const h = Math.floor(ce.tMinusMinutes / 60);
        const m2 = ce.tMinusMinutes % 60;
        const tStr = h > 0 ? `${h}h ${m2}m` : `${m2}m`;
        lines.push(`- ⚠️ T-minus ${tStr} until game start`);
        if (ce.tMinusMinutes < 30) lines.push(`- 🚨 UNDER 30 MIN — book may shift rapidly`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(
    "_Run `npm run ingest:kalshi` to refresh. Full data: data/processed/latest-kalshi.json_",
  );

  return lines.join("\n");
}

/** Standalone latest-kalshi-agents.md (no markers — full file) — for betting agent */
function formatStandaloneAgentsMd(
  markets: ProcessedMarket[],
  fetchedAt: Date,
): string {
  const timeStr = etDisplayStr(fetchedAt);
  const top10 = markets.slice(0, 10);
  const lines: string[] = [
    `# Kalshi Markets Snapshot — ${timeStr} ET`,
    `_Last refreshed: ${timeStr} ET | ${markets.length} markets tracked_`,
    "",
    "## Top 10 by Liquidity",
    "",
  ];

  for (let i = 0; i < top10.length; i++) {
    const m = top10[i];
    const implStr = m.impliedProbYes !== null ? `${m.impliedProbYes}%` : "—";
    const spreadStr = m.spread !== null ? `${Math.round(m.spread)}¢` : "incomplete";
    const closeStr = m.closeTime
      ? new Date(m.closeTime).toLocaleDateString()
      : "Unknown";

    lines.push(`**${i + 1}. ${m.title || m.ticker}**`);
    lines.push(
      `YES bid/ask: ${fmtCents(m.yesBid)} / ${fmtCents(m.yesAsk)} → Implied: ${implStr}`,
    );
    lines.push(
      `Spread: ${spreadStr} | Actionability: ${m.actionability} | Liq: ${m.openInterest.toLocaleString()}`,
    );
    lines.push(`Closes: ${closeStr} | Status: ${m.status}`);
    lines.push("");
  }

  lines.push("_Run `npm run ingest:kalshi` to refresh._");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = process.cwd();
  apiCallCount = 0;

  console.log(`[kalshi] Starting ingest (env=${KALSHI_ENV}, base=${BASE_URL})`);

  const fetchedAt = new Date();

  // 0. Load supporting data
  const priceHistory = loadPriceHistory(root);
  const injuries = loadInjuries(root);
  const tournamentRatings = loadTournamentRatings(root);

  const nbaInjCount = injuries.nba.length;
  const nflInjCount = injuries.nfl.length;
  if (nbaInjCount + nflInjCount > 0) {
    console.log(`  [kalshi] Injuries loaded: NBA ${nbaInjCount}, NFL ${nflInjCount}`);
  }

  // 1. Discover markets
  const { markets: rawMarkets, eventsScanned } = await fetchAllMarkets();

  // Sort by open interest (best liquidity proxy) then cap
  rawMarkets.sort((a, b) => (b.open_interest ?? 0) - (a.open_interest ?? 0));
  const topMarkets = rawMarkets.slice(0, MAX_MARKETS);
  if (rawMarkets.length > MAX_MARKETS) {
    console.log(`  [kalshi] Capped to top ${MAX_MARKETS} markets by open interest (${rawMarkets.length} total)`);
  }

  // 2. Today's game markets — inject any that didn't make the OI cap, then boost all
  //    to front of the orderbook fetch queue so they always get real bid/ask data.
  const _etToday = toEtIso(new Date()).slice(0, 10); // "YYYY-MM-DD"
  const _MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const [_yyyy, _mm, _dd] = _etToday.split("-");
  const todayKalshiStr = `${_yyyy.slice(-2)}${_MONTHS[parseInt(_mm, 10) - 1]}${_dd}`;
  const gameBoostStr = `GAME-${todayKalshiStr}`;

  // Inject game markets from the full rawMarkets list that fell outside the OI cap
  const topTickerSet = new Set(topMarkets.map((m) => m.ticker));
  const injectedGameMarkets = rawMarkets.filter(
    (m) => m.ticker.toUpperCase().includes(gameBoostStr) && !topTickerSet.has(m.ticker),
  );
  if (injectedGameMarkets.length > 0) {
    console.log(
      `  [kalshi] Injected ${injectedGameMarkets.length} today-game markets outside top ${MAX_MARKETS} OI`,
    );
  }

  // Combined pool: original top-N + injected game markets
  const allMarkets = [...topMarkets, ...injectedGameMarkets];
  const gameMarketsToday = allMarkets.filter(
    (m) => m.ticker.toUpperCase().includes(gameBoostStr),
  );
  const remainingMarkets = allMarkets.filter(
    (m) => !m.ticker.toUpperCase().includes(gameBoostStr),
  );
  if (gameMarketsToday.length > 0) {
    console.log(
      `  [kalshi] Game boost: ${gameMarketsToday.length} today-game markets (${todayKalshiStr}) at front of OB list`,
    );
  }
  // Game markets first, then remaining by OI, capped at MAX_OB_FETCH
  const obCandidates = [...gameMarketsToday, ...remainingMarkets].slice(0, MAX_OB_FETCH);
  const tickers = obCandidates.map((m) => m.ticker);
  console.log(`  [kalshi] Fetching orderbooks for top ${tickers.length} markets (KALSHI_MAX_OB=${MAX_OB_FETCH})...`);
  const obMap = await batchFetchOrderbooks(tickers);

  const orderbookErrors = [...obMap.values()].filter((v) => v === null).length;
  const orderbooksFetched = obMap.size - orderbookErrors;

  // 3. Process markets (allMarkets = topMarkets + injected game markets)
  const processed = allMarkets
    .map((m) => processMarket(m, obMap.get(m.ticker) ?? null))
    .filter((m) => m.yesMid !== null || m.yesBid !== null); // drop fully empty markets

  // 4. Update price history with current mid prices
  updatePriceHistory(processed, priceHistory);
  savePriceHistory(root, priceHistory);

  // Compute avg field SRS using only the MARMAD teams (not all NCAAB teams)
  // so the baseline represents the actual tournament field, not the entire D1 universe.
  let avgFieldSrs = 0;
  if (tournamentRatings) {
    const uniqueTeamNames = [...new Set(Object.values(MARMAD_TICKER_TO_TEAM))];
    const fieldSrs: number[] = [];
    for (const teamName of uniqueTeamNames) {
      const srs = findNcaabRating(teamName, tournamentRatings.teams);
      if (srs !== null) fieldSrs.push(srs);
    }
    avgFieldSrs = fieldSrs.length ? fieldSrs.reduce((s, v) => s + v, 0) / fieldSrs.length : 0;
    if (fieldSrs.length > 0) {
      console.log(`  [marmad] avgFieldSrs from ${fieldSrs.length} MARMAD teams: ${avgFieldSrs.toFixed(1)}`);
    }
  }

  // 5. Cross-edge analysis + movement signals + tournament edges
  // Load both Pinnacle odds (primary) and NateStacks picks (fallback)
  const [pinnacleMap, bestBets] = await Promise.all([
    loadPinnacleOdds(),
    Promise.resolve(loadBestBets(root)),
  ]);
  if (pinnacleMap.size > 0) {
    console.log(`  [cross-edge] Pinnacle map ready (${pinnacleMap.size} variants) against ${processed.length} markets...`);
  } else if (bestBets.length > 0) {
    console.log(`  [cross-edge] Checking ${bestBets.length} NateStacks bets against ${processed.length} markets (no TR)...`);
  }

  const sportsMarkets: ProcessedMarket[] = [];
  const crossEdgeMarkets: ProcessedMarket[] = [];
  const tournamentEdgeMarkets: ProcessedMarket[] = [];
  const crossEdgeMisses: CrossEdgeMiss[] = [];

  for (const m of processed) {
    if (m.isSports) sportsMarkets.push(m);

    const isMarmad = m.ticker.toUpperCase().startsWith("KXMARMAD");

    // Tournament edge (March Madness futures)
    if (isMarmad && tournamentRatings) {
      const te = findTournamentEdge(m, tournamentRatings, avgFieldSrs);
      if (te) {
        m.tournamentEdge = te;
        tournamentEdgeMarkets.push(m);
      }
    }

    // Game cross-edge: TR Pinnacle (primary) → NateStacks (fallback)
    if (!isMarmad && m.isSports && isGameWinnerMarket(m)) {
      let ce: CrossEdge | undefined;
      // Primary: TheRundown Pinnacle devigged odds
      if (pinnacleMap.size > 0) {
        ce = findCrossEdgeFromPinnacle(m, pinnacleMap, injuries, crossEdgeMisses);
      }
      // Fallback: NateStacks model picks
      if (!ce && bestBets.length > 0) {
        ce = findCrossEdge(m, bestBets, injuries, crossEdgeMisses);
      }
      if (ce) {
        ce.movementSignal = computeMovement(m.ticker, ce.modelConfidence, priceHistory);
        m.crossEdge = ce;
        crossEdgeMarkets.push(m);
      }
    }
  }

  // Data age = 0 when written fresh; useful when AGENTS.md is read later
  const fetchedAtIsoUtc = fetchedAt.toISOString();
  const fetchedAtIsoEt = toEtIso(fetchedAt);
  const dataAgeMinutes = 0; // age at time of write

  // 5. Write JSON output (atomic)
  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  // Ensure alert log file exists so downstream heartbeat/nightly review can read it
  // even when the real-time watcher is not running.
  const alertsJsonlPath = path.join(outDir, "kalshi-alerts.jsonl");
  if (!fs.existsSync(alertsJsonlPath)) {
    fs.writeFileSync(alertsJsonlPath, "", "utf-8");
    console.log(`[kalshi] Initialized: ${alertsJsonlPath}`);
  }

  const output: KalshiOutput = {
    fetchedAtIsoUtc,
    fetchedAtIsoEt,
    env: KALSHI_ENV,
    totalFetched: processed.length,
    sportsCount: sportsMarkets.length,
    crossEdgeCount: crossEdgeMarkets.length,
    tournamentEdgeCount: tournamentEdgeMarkets.length,
    markets: processed,
    sportsMarkets,
    crossEdgeMarkets,
    tournamentEdgeMarkets,
    stats: {
      apiCallsMade: apiCallCount,
      eventsScanned,
      orderbooksFetched,
      orderbookErrors,
      excludedClosed: rawMarkets.length - tickers.length,
    },
  };

  // Persist machine-readable ingest/cross-edge telemetry for nightly outcome analysis.
  const telemetryRows: string[] = [];
  telemetryRows.push(
    JSON.stringify({
      type: "ingest_summary",
      ts: fetchedAtIsoUtc,
      env: KALSHI_ENV,
      totalFetched: processed.length,
      sportsCount: sportsMarkets.length,
      crossEdgeCount: crossEdgeMarkets.length,
      tournamentEdgeCount: tournamentEdgeMarkets.length,
      apiCallsMade: apiCallCount,
    }),
  );

  for (const m of crossEdgeMarkets) {
    const ce = m.crossEdge;
    if (!ce) continue;
    telemetryRows.push(
      JSON.stringify({
        type: "cross_edge_snapshot",
        ts: fetchedAtIsoUtc,
        marketId: m.ticker,
        ticker: m.ticker,
        title: m.title,
        direction: ce.direction,
        gapPct: ce.gap,
        kalshiImpliedPct: ce.kalshiImplied,
        modelConfidencePct: ce.modelConfidence,
        actionability: m.actionability,
        yesBid: m.yesBid,
        yesAsk: m.yesAsk,
        spread: m.spread,
        tMinusMinutes: ce.tMinusMinutes ?? null,
        closeTime: m.closeTime,
        matchedVia: ce.matchedVia,
      }),
    );
  }

  fs.appendFileSync(alertsJsonlPath, telemetryRows.join("\n") + "\n", "utf-8");

  const jsonPath = path.join(outDir, "latest-kalshi.json");
  fs.writeFileSync(jsonPath + ".tmp", JSON.stringify(output, null, 2), "utf-8");
  fs.renameSync(jsonPath + ".tmp", jsonPath);
  console.log(`[kalshi] Written: ${jsonPath}`);

  const missSummary = crossEdgeMisses.reduce<Record<string, number>>((acc, m) => {
    acc[m.reason] = (acc[m.reason] ?? 0) + 1;
    return acc;
  }, {});
  const missOut = {
    generatedAtIsoUtc: fetchedAtIsoUtc,
    bestBetsChecked: bestBets.length,
    sportsMarketsChecked: sportsMarkets.length,
    missSummary,
    sampleMisses: crossEdgeMisses.slice(0, 200),
  };
  const missPath = path.join(outDir, "kalshi-crossedge-misses.json");
  fs.writeFileSync(missPath + ".tmp", JSON.stringify(missOut, null, 2), "utf-8");
  fs.renameSync(missPath + ".tmp", missPath);
  console.log(`[kalshi] Written: ${missPath}`);

  // 6. Write standalone latest-kalshi-agents.md (for betting agent compat)
  const standaloneMd = formatStandaloneAgentsMd(processed, fetchedAt);
  const mdPath = path.join(outDir, "latest-kalshi-agents.md");
  fs.writeFileSync(mdPath + ".tmp", standaloneMd, "utf-8");
  fs.renameSync(mdPath + ".tmp", mdPath);
  console.log(`[kalshi] Written: ${mdPath}`);

  // 7. Update workspace AGENTS.md (between markers)
  const agentsMdPath =
    process.env.POLYEDGE_AGENTS_MD_PATH ??
    path.join(
      process.env.OPENCLAW_WORKSPACE_KALSHI ??
        "C:\\Users\\nbber\\.openclaw\\workspace-kalshi",
      "AGENTS.md",
    );
  const block = formatAgentsMdBlock(
    processed,
    crossEdgeMarkets,
    fetchedAt,
    dataAgeMinutes,
  );
  updateAgentsMd(agentsMdPath, block);

  // 8. Summary
  console.log(
    `[kalshi] Done: ${processed.length} markets | ${sportsMarkets.length} sports | ` +
      `${crossEdgeMarkets.length} cross-edge | ${tournamentEdgeMarkets.length} tournament-edge | API calls: ${apiCallCount}`,
  );
}

main().catch((err) => {
  console.error("[kalshi] Fatal:", err);
  process.exit(1);
});
