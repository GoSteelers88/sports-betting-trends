/**
 * alpaca.ts — minimal Alpaca PAPER trading + market-data client for the PEAD
 * book. Paper-only by construction: the trading base URL is hardcoded to
 * paper-api.alpaca.markets, so these keys cannot touch a live account.
 */
import fs from "node:fs";
import path from "node:path";

const TRADE_BASE = "https://paper-api.alpaca.markets/v2";
const DATA_BASE = "https://data.alpaca.markets/v2";

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

function creds(): { key: string; secret: string } {
  loadEnvOnce();
  return {
    key: process.env.ALPACA_PAPER_KEY_ID ?? process.env.APCA_API_KEY_ID ?? "",
    secret: process.env.ALPACA_PAPER_SECRET ?? process.env.APCA_API_SECRET_KEY ?? "",
  };
}

export function alpacaConfigured(): boolean {
  const c = creds();
  return Boolean(c.key && c.secret);
}

async function afetch(base: string, endpoint: string, init?: RequestInit): Promise<any> {
  const c = creds();
  const res = await fetch(`${base}${endpoint}`, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": c.key,
      "APCA-API-SECRET-KEY": c.secret,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca ${endpoint} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function marketIsOpen(): Promise<boolean> {
  const clock = await afetch(TRADE_BASE, "/clock");
  return Boolean(clock?.is_open);
}

export async function getAsset(
  symbol: string,
): Promise<{ tradable: boolean; fractionable: boolean } | null> {
  const a = await afetch(TRADE_BASE, `/assets/${encodeURIComponent(symbol)}`);
  return a ? { tradable: Boolean(a.tradable), fractionable: Boolean(a.fractionable) } : null;
}

export async function latestTradePrice(symbol: string): Promise<number | null> {
  const r = await afetch(
    DATA_BASE,
    `/stocks/trades/latest?symbols=${encodeURIComponent(symbol)}&feed=iex`,
  );
  const p = Number(r?.trades?.[symbol]?.p);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** Average daily dollar volume over the last `days` sessions (IEX feed). */
export async function avgDollarVolume(symbol: string, days = 5): Promise<number | null> {
  // start is required in practice: it defaults to TODAY, which yields at most
  // one partial bar. sort=desc + limit takes the most recent sessions (asc
  // would truncate to the oldest bars in the window).
  const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const r = await afetch(
    DATA_BASE,
    `/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day` +
      `&start=${encodeURIComponent(start)}&limit=${days}&feed=iex&adjustment=split&sort=desc`,
  );
  const bars: any[] = r?.bars?.[symbol] ?? [];
  if (bars.length === 0) return null;
  const dv = bars.map((b) => Number(b.c) * Number(b.v)).filter(Number.isFinite);
  return dv.length > 0 ? dv.reduce((s, x) => s + x, 0) / dv.length : null;
}

export interface AlpacaOrder {
  id: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
}

export async function placeMarketOrder(opts: {
  symbol: string;
  side: "buy" | "sell";
  notional?: number;
  qty?: number;
}): Promise<AlpacaOrder> {
  return afetch(TRADE_BASE, "/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: opts.symbol,
      side: opts.side,
      type: "market",
      time_in_force: "day",
      ...(opts.notional != null ? { notional: String(opts.notional) } : {}),
      ...(opts.qty != null ? { qty: String(opts.qty) } : {}),
    }),
  });
}

export async function getOrder(id: string): Promise<AlpacaOrder | null> {
  return afetch(TRADE_BASE, `/orders/${id}`);
}

/** Current paper position qty for a symbol, or null when flat. */
export async function getPositionQty(symbol: string): Promise<number | null> {
  const p = await afetch(TRADE_BASE, `/positions/${encodeURIComponent(symbol)}`);
  const q = Number(p?.qty);
  return Number.isFinite(q) && q !== 0 ? q : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until an order fills (market orders in RTH fill near-instantly on paper). */
export async function waitForFill(
  orderId: string,
  timeoutMs = 45_000,
): Promise<{ qty: number; price: number } | null> {
  const deadline = Date.now() + timeoutMs;
  let last: AlpacaOrder | null = null;
  while (Date.now() < deadline) {
    const o = await getOrder(orderId);
    if (o) last = o;
    if (o?.status === "filled") {
      const qty = Number(o.filled_qty);
      const price = Number(o.filled_avg_price);
      if (qty > 0 && price > 0) return { qty, price };
    }
    if (o && ["canceled", "expired", "rejected"].includes(o.status)) return null;
    await sleep(2_000);
  }
  // Alpaca paper randomly simulates partial fills (~10% of orders). If the
  // remainder is still working at the deadline, book what actually filled —
  // the rows record reality, not the order's intent.
  if (last?.status === "partially_filled") {
    const qty = Number(last.filled_qty);
    const price = Number(last.filled_avg_price);
    if (qty > 0 && price > 0) return { qty, price };
  }
  return null;
}
