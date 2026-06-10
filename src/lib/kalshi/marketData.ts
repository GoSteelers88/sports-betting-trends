/**
 * marketData.ts — clean Kalshi market-data client for the favorite-longshot
 * paper trail, written against the CURRENT (2026) API schema.
 *
 * Why this exists (and the old ingest-kalshi.ts does not work): Kalshi migrated
 * its market objects to `*_dollars` (string) prices and `*_fp` (fixed-point)
 * sizes. The old integer-cent fields (yes_bid, yes_ask, open_interest, …) that
 * the March-era autopilots read are gone. We also discovered the raw
 * /markets?status=open feed is dominated by `KXMVE*` multi-leg combo/parlay
 * markets with no two-sided prices — so we go EVENTS-first (which also carries
 * `category`) and exclude the MVE series.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const PATH_PREFIX = "/trade-api/v2";

// Minimal .env loader so the CLI runner (tsx) gets creds without Next's env.
let _envLoaded = false;
function loadEnvOnce(): void {
  if (_envLoaded) return;
  _envLoaded = true;
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* ignore */
  }
}

function authHeaders(method: string, urlPath: string): Record<string, string> {
  loadEnvOnce();
  const apiKey = process.env.KALSHI_API_KEY_ID ?? "";
  const pemPath =
    process.env.KALSHI_PRIVATE_KEY_PEM_PATH ?? process.env.KALSHI_PRIVATE_KEY_PATH ?? "";
  if (!apiKey || !pemPath || !fs.existsSync(pemPath)) return {};
  const pem = fs.readFileSync(pemPath, "utf-8");
  const ts = Date.now().toString();
  const signer = crypto.createSign("SHA256");
  signer.update(ts + method.toUpperCase() + urlPath);
  const sig = signer.sign(
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );
  return {
    "KALSHI-ACCESS-KEY": apiKey,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig,
  };
}

async function kfetch(endpoint: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${endpoint}?${qs}`, {
    headers: { ...authHeaders("GET", PATH_PREFIX + endpoint), Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kalshi ${endpoint} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const num = (v: unknown): number | null => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  category: string;
  title: string;
  yesBid: number; // dollars, 0–1
  yesAsk: number; // dollars, 0–1
  lastPrice: number | null;
  openInterest: number;
  volume: number;
  closeTime: string; // ISO
  status: string;
  result: string | null; // "yes" | "no" | null
}

function parseMarket(m: any, category: string): KalshiMarket | null {
  const yesAsk = num(m.yes_ask_dollars);
  const yesBid = num(m.yes_bid_dollars);
  if (yesAsk == null || yesBid == null) return null;
  return {
    ticker: String(m.ticker ?? ""),
    eventTicker: String(m.event_ticker ?? ""),
    category,
    title: String(m.title ?? m.yes_sub_title ?? m.ticker ?? ""),
    yesBid,
    yesAsk,
    lastPrice: num(m.last_price_dollars),
    openInterest: num(m.open_interest_fp) ?? 0,
    volume: num(m.volume_fp) ?? 0,
    closeTime: String(m.close_time ?? ""),
    status: String(m.status ?? ""),
    result: m.result === "yes" || m.result === "no" ? m.result : null,
  };
}

/**
 * Pull all open, real (non-MVE) binary markets that have live two-sided prices,
 * each tagged with its event category. Paginates the /events feed.
 */
export async function fetchOpenMarkets(maxPages = 30): Promise<KalshiMarket[]> {
  let cursor = "";
  const out: KalshiMarket[] = [];
  for (let i = 0; i < maxPages; i++) {
    const params: Record<string, string> = {
      status: "open",
      limit: "200",
      with_nested_markets: "true",
    };
    if (cursor) params.cursor = cursor;
    const page = await kfetch("/events", params);
    const events: any[] = page.events ?? [];
    for (const ev of events) {
      if (String(ev.series_ticker ?? "").startsWith("KXMVE")) continue; // skip parlay combos
      const cat = String(ev.category ?? "Other");
      for (const m of ev.markets ?? []) {
        const parsed = parseMarket(m, cat);
        if (parsed && parsed.yesAsk > 0 && parsed.yesAsk < 1 && parsed.yesBid > 0) {
          out.push(parsed);
        }
      }
    }
    cursor = page.cursor ?? "";
    if (!cursor || events.length === 0) break;
  }
  return out;
}

export interface MarketState {
  status: string;
  result: string | null;
  yesBid: number | null;
}

/**
 * Look up current status + settlement result for specific held tickers, batched.
 * Used by the settlement watcher to close paper positions when markets resolve.
 */
export async function fetchMarketStates(tickers: string[]): Promise<Map<string, MarketState>> {
  const map = new Map<string, MarketState>();
  const uniq = [...new Set(tickers)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    if (chunk.length === 0) break;
    const page = await kfetch("/markets", { tickers: chunk.join(","), limit: "100" });
    for (const m of page.markets ?? []) {
      map.set(String(m.ticker), {
        status: String(m.status ?? ""),
        result: m.result === "yes" || m.result === "no" ? m.result : null,
        yesBid: num(m.yes_bid_dollars),
      });
    }
  }
  return map;
}
