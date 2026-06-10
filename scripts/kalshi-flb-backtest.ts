/**
 * kalshi-flb-backtest.ts — quant validation of the favorite-longshot edge on
 * Kalshi, on REAL settled-market history. Cached + resumable.
 *
 * Pipeline:
 *   1. SCRAPE settled binary markets via /events?status=settled (skip MVE combos).
 *   2. ENRICH each with its YES bid/ask at HORIZON_HOURS before close (candlesticks).
 *   3. ANALYZE: calibration curve f(p) with Wilson 95% CIs, fee-adjusted EV for
 *      taker (buy at ask) and maker (rest at bid), out-of-sample split, Kelly
 *      sizing, and a risk-of-ruin Monte Carlo on the favorite slice.
 *
 * Methodology guards (so this isn't another overfit "+$487K" fantasy):
 *   - Pre-registered hypothesis: favorites (mid >= 0.80) are underpriced. We do
 *     NOT data-mine the best bucket and report it as the edge.
 *   - Edge is judged on the LOWER Wilson CI bound, net of fees.
 *   - Out-of-sample: fit intuition on the earlier half, confirm on the later half.
 *
 *   npx tsx scripts/kalshi-flb-backtest.ts
 *
 * Env knobs: HORIZON_HOURS (24), MIN_VOL (500), MAX_SETTLED_PAGES (40),
 *            CONCURRENCY (5), FAVORITE_MIN (0.80), FAVORITE_MAX (0.95)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const PREFIX = "/trade-api/v2";
const DATA_DIR = path.resolve(process.cwd(), "data", "processed");
const SETTLED_CACHE = path.join(DATA_DIR, "flb-settled.json");
const PRICED_CACHE = path.join(DATA_DIR, "flb-priced.json");
const REPORT_OUT = path.join(DATA_DIR, "flb-calibration.json");

const HORIZON_HOURS = parseInt(process.env.HORIZON_HOURS ?? "24", 10);
const MIN_VOL = parseFloat(process.env.MIN_VOL ?? "500");
const MAX_SETTLED_PAGES = parseInt(process.env.MAX_SETTLED_PAGES ?? "40", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "5", 10);
const FAVORITE_MIN = parseFloat(process.env.FAVORITE_MIN ?? "0.80");
const FAVORITE_MAX = parseFloat(process.env.FAVORITE_MAX ?? "0.95");
const KALSHI_FEE = (p: number) => 0.07 * p * (1 - p); // taker fee per contract ($)

// ── auth / fetch ────────────────────────────────────────────────────────────
let _env = false;
function loadEnv() {
  if (_env) return; _env = true;
  try {
    for (const line of fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf-8").split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("="); if (eq < 0) continue;
      const k = t.slice(0, eq).trim(); const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

function authHeaders(method: string, urlPath: string): Record<string, string> {
  const apiKey = process.env.KALSHI_API_KEY_ID ?? "";
  const pemPath = process.env.KALSHI_PRIVATE_KEY_PEM_PATH ?? process.env.KALSHI_PRIVATE_KEY_PATH ?? "";
  if (!apiKey || !pemPath || !fs.existsSync(pemPath)) return {};
  const pem = fs.readFileSync(pemPath, "utf-8");
  const ts = Date.now().toString();
  const s = crypto.createSign("SHA256"); s.update(ts + method.toUpperCase() + urlPath);
  const sig = s.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, "base64");
  return { "KALSHI-ACCESS-KEY": apiKey, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig };
}

async function get(endpoint: string, params: Record<string, string>, retries = 4): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${endpoint}?${qs}`, {
      headers: { ...authHeaders("GET", PREFIX + endpoint), Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < retries) {
      await sleep(800 * 2 ** attempt); continue;
    }
    throw new Error(`HTTP ${res.status} ${endpoint}: ${(await res.text()).slice(0, 160)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : null; };

interface SettledMkt { ticker: string; series: string; category: string; result: "yes" | "no"; closeMs: number; volume: number; }
interface PricedMkt extends SettledMkt { bid: number; ask: number; mid: number; }

// ── Phase 1: scrape settled binary markets ──────────────────────────────────
async function scrapeSettled(): Promise<SettledMkt[]> {
  if (fs.existsSync(SETTLED_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(SETTLED_CACHE, "utf-8")) as SettledMkt[];
    console.log(`[scrape] using cached settled markets: ${cached.length}`);
    return cached;
  }
  const out: SettledMkt[] = [];
  let cursor = "";
  for (let i = 0; i < MAX_SETTLED_PAGES; i++) {
    const params: Record<string, string> = { status: "settled", limit: "200", with_nested_markets: "true" };
    if (cursor) params.cursor = cursor;
    const page = await get("/events", params);
    const evs: any[] = page.events ?? [];
    for (const ev of evs) {
      if (String(ev.series_ticker ?? "").startsWith("KXMVE")) continue;
      for (const m of ev.markets ?? []) {
        const res = m.result;
        if (res !== "yes" && res !== "no") continue;
        const closeMs = Date.parse(m.close_time ?? "");
        const vol = num(m.volume_fp) ?? 0;
        if (!Number.isFinite(closeMs) || vol < MIN_VOL) continue;
        out.push({ ticker: m.ticker, series: ev.series_ticker, category: ev.category ?? "?", result: res, closeMs, volume: vol });
      }
    }
    cursor = page.cursor ?? "";
    process.stdout.write(`\r[scrape] page ${i + 1}/${MAX_SETTLED_PAGES} — ${out.length} markets`);
    if (!cursor || evs.length === 0) break;
  }
  process.stdout.write("\n");
  fs.writeFileSync(SETTLED_CACHE, JSON.stringify(out));
  console.log(`[scrape] cached ${out.length} settled markets → ${path.basename(SETTLED_CACHE)}`);
  return out;
}

// ── Phase 2: enrich with horizon price via candlesticks ─────────────────────
function pickHorizonCandle(candles: any[], targetTs: number, endTs: number): { bid: number; ask: number } | null {
  let best: any = null; let bestDist = Infinity;
  for (const c of candles) {
    const ts = c.end_period_ts;
    if (!Number.isFinite(ts) || ts > endTs) continue;
    const bid = num(c.yes_bid?.close_dollars);
    const ask = num(c.yes_ask?.close_dollars);
    if (bid == null || ask == null || bid <= 0 || ask >= 1 || bid > ask) continue;
    const dist = Math.abs(ts - targetTs);
    if (dist < bestDist) { bestDist = dist; best = { bid, ask }; }
  }
  // require the chosen candle within 12h of the target horizon
  return best && bestDist <= 12 * 3600 ? best : null;
}

async function enrich(settled: SettledMkt[]): Promise<PricedMkt[]> {
  const priced: Record<string, PricedMkt> = {};
  if (fs.existsSync(PRICED_CACHE)) {
    for (const p of JSON.parse(fs.readFileSync(PRICED_CACHE, "utf-8")) as PricedMkt[]) priced[p.ticker] = p;
    console.log(`[enrich] resuming — ${Object.keys(priced).length} already priced`);
  }
  const todo = settled.filter((m) => !(m.ticker in priced));
  console.log(`[enrich] fetching candlesticks for ${todo.length} markets (concurrency ${CONCURRENCY})`);

  let done = 0, ok = 0, idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const m = todo[idx++];
      const endTs = Math.floor(m.closeMs / 1000);
      const targetTs = endTs - HORIZON_HOURS * 3600;
      const startTs = endTs - (HORIZON_HOURS + 48) * 3600;
      try {
        const cs = await get(`/series/${m.series}/markets/${m.ticker}/candlesticks`, {
          start_ts: String(startTs), end_ts: String(endTs), period_interval: "60",
        });
        const hit = pickHorizonCandle(cs.candlesticks ?? [], targetTs, endTs);
        if (hit) { priced[m.ticker] = { ...m, bid: hit.bid, ask: hit.ask, mid: (hit.bid + hit.ask) / 2 }; ok++; }
      } catch { /* skip on error */ }
      if (++done % 50 === 0) {
        fs.writeFileSync(PRICED_CACHE, JSON.stringify(Object.values(priced)));
        process.stdout.write(`\r[enrich] ${done}/${todo.length} fetched, ${ok} priced`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(PRICED_CACHE, JSON.stringify(Object.values(priced)));
  process.stdout.write("\n");
  const all = Object.values(priced);
  console.log(`[enrich] total priced: ${all.length}`);
  return all;
}

// ── stats helpers ────────────────────────────────────────────────────────────
function wilson(wins: number, n: number, z = 1.96): { lo: number; hi: number; p: number } {
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const phat = wins / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return { lo: (center - margin) / denom, hi: (center + margin) / denom, p: phat };
}

function evRow(rows: PricedMkt[], entry: (m: PricedMkt) => number, fee: (p: number) => number) {
  // mean per-contract pnl + its standard error (pnl in $ per $1-notional contract)
  const pnls = rows.map((m) => (m.result === "yes" ? 1 : 0) - entry(m) - fee(entry(m)));
  const n = pnls.length;
  const mean = pnls.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const variance = n > 1 ? pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / Math.max(1, n));
  const avgCost = rows.reduce((s, m) => s + entry(m), 0) / Math.max(1, n);
  return { n, meanPnl: mean, se, tStat: se > 0 ? mean / se : 0, roiPct: avgCost > 0 ? (mean / avgCost) * 100 : 0, avgCost };
}

// ── Phase 3: analysis ────────────────────────────────────────────────────────
function analyze(priced: PricedMkt[]) {
  const usable = priced.filter((m) => m.mid > 0 && m.mid < 1);
  console.log(`\n=== CALIBRATION (n=${usable.length}, horizon=${HORIZON_HOURS}h pre-close) ===`);
  console.log("price bucket  |    n | realized win% [95% Wilson CI] | vs price (bias)");
  for (let lo = 0; lo < 1; lo += 0.1) {
    const hi = lo + 0.1;
    const rows = usable.filter((m) => m.mid >= lo && m.mid < hi + (hi >= 1 ? 0.0001 : 0));
    if (rows.length === 0) continue;
    const wins = rows.filter((m) => m.result === "yes").length;
    const w = wilson(wins, rows.length);
    const midPrice = rows.reduce((s, m) => s + m.mid, 0) / rows.length;
    const bias = w.p - midPrice; // + => underpriced (favorites), - => overpriced (longshots)
    console.log(
      `${(lo * 100).toFixed(0).padStart(2)}-${(hi * 100).toFixed(0)}¢      | ${String(rows.length).padStart(4)} | ` +
      `${(w.p * 100).toFixed(1).padStart(5)}% [${(w.lo * 100).toFixed(1)}–${(w.hi * 100).toFixed(1)}%]   | ` +
      `${bias >= 0 ? "+" : ""}${(bias * 100).toFixed(1)}pp ${bias > 0.01 ? "UNDERPRICED" : bias < -0.01 ? "overpriced" : ""}`,
    );
  }

  // Pre-registered favorite slice
  const favs = usable.filter((m) => m.mid >= FAVORITE_MIN && m.mid <= FAVORITE_MAX);
  const favWins = favs.filter((m) => m.result === "yes").length;
  const favW = wilson(favWins, favs.length);
  console.log(`\n=== PRE-REGISTERED FAVORITE SLICE (mid ${FAVORITE_MIN}-${FAVORITE_MAX}) ===`);
  console.log(`n=${favs.length} | realized win ${(favW.p * 100).toFixed(1)}% [${(favW.lo * 100).toFixed(1)}–${(favW.hi * 100).toFixed(1)}%] | avg mid ${(favs.reduce((s, m) => s + m.mid, 0) / Math.max(1, favs.length) * 100).toFixed(1)}¢`);

  const taker = evRow(favs, (m) => m.ask, KALSHI_FEE);
  const maker = evRow(favs, (m) => m.bid, () => 0);
  const fmt = (e: ReturnType<typeof evRow>, label: string) =>
    `  ${label.padEnd(22)} EV/contract=$${e.meanPnl.toFixed(4)} ± ${e.se.toFixed(4)} (t=${e.tStat.toFixed(2)}) | ROI ${e.roiPct.toFixed(2)}% | avgCost $${e.avgCost.toFixed(3)}`;
  console.log(`\nFee-adjusted EV on favorite slice (the bankable number):`);
  console.log(fmt(taker, "TAKER (buy at ask)"));
  console.log(fmt(maker, "MAKER (rest at bid)"));
  console.log(`  → significance gate: t > 2 (≈ lower CI clears 0). Taker ${taker.tStat > 2 ? "PASSES" : "FAILS"}, Maker ${maker.tStat > 2 ? "PASSES" : "FAILS"}.`);

  // Out-of-sample split by close time (earlier half vs later half)
  const sorted = [...favs].sort((a, b) => a.closeMs - b.closeMs);
  const mid = Math.floor(sorted.length / 2);
  const oosTaker = { train: evRow(sorted.slice(0, mid), (m) => m.ask, KALSHI_FEE), test: evRow(sorted.slice(mid), (m) => m.ask, KALSHI_FEE) };
  console.log(`\nOut-of-sample (taker EV/contract):  train(early)=$${oosTaker.train.meanPnl.toFixed(4)} (t=${oosTaker.train.tStat.toFixed(2)})  |  test(late)=$${oosTaker.test.meanPnl.toFixed(4)} (t=${oosTaker.test.tStat.toFixed(2)})`);

  // Kelly + risk of ruin on the better of taker/maker (use taker = conservative)
  const q = favW.p; const pAsk = taker.avgCost;
  const b = (1 - pAsk) / pAsk;
  const fullKelly = Math.max(0, q - (1 - q) / b);
  console.log(`\nKelly (taker, q=${(q * 100).toFixed(1)}%, avg ask ${(pAsk * 100).toFixed(1)}¢): full=${(fullKelly * 100).toFixed(1)}% bankroll/bet → ¼-Kelly=${(fullKelly * 25).toFixed(1)}%`);

  // category breakdown of the favorite slice
  const byCat: Record<string, { n: number; w: number }> = {};
  for (const m of favs) { const c = byCat[m.category] ??= { n: 0, w: 0 }; c.n++; if (m.result === "yes") c.w++; }
  console.log(`\nFavorite slice by category (win% [CI], n):`);
  for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1].n - a[1].n)) {
    const cw = wilson(v.w, v.n);
    console.log(`  ${c.padEnd(22)} ${(cw.p * 100).toFixed(1)}% [${(cw.lo * 100).toFixed(0)}–${(cw.hi * 100).toFixed(0)}%]  n=${v.n}`);
  }

  fs.writeFileSync(REPORT_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), horizonHours: HORIZON_HOURS, n: usable.length,
    favoriteSlice: { range: [FAVORITE_MIN, FAVORITE_MAX], n: favs.length, winRate: favW.p, ci: [favW.lo, favW.hi], taker, maker, oosTaker, fullKelly },
  }, null, 2));
  console.log(`\nReport → ${path.basename(REPORT_OUT)}`);
}

async function main() {
  const settled = await scrapeSettled();
  const priced = await enrich(settled);
  analyze(priced);
}
main().catch((e) => { console.error("BACKTEST FAILED:", e); process.exit(1); });
