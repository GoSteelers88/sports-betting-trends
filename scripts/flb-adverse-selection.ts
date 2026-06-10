/**
 * flb-adverse-selection.ts — the make-or-break test for the maker edge.
 *
 * For each favorite (mid 0.80-0.95) we'd rest a BUY limit at the entry bid 24h
 * pre-close. Using the candlestick path from entry→close we ask:
 *   (a) FILL: did the ask ever drop to our bid? (yes_ask.low <= entryBid)
 *   (b) ADVERSE SELECTION: do FILLED favorites win as often as ALL favorites,
 *       or do we get picked off (filled mostly on the ones about to lose)?
 *
 * The realized maker edge is EV over FILLED bets only — that's deployed capital.
 * If filled-only win% craters toward the price, the +6.4% maker number is a mirage.
 *
 *   npx tsx scripts/flb-adverse-selection.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const PREFIX = "/trade-api/v2";
const DIR = path.resolve(process.cwd(), "data", "processed");
const PRICED = path.join(DIR, "flb-priced.json");
const FILLS = path.join(DIR, "flb-fills.json");
const HORIZON_HOURS = parseInt(process.env.HORIZON_HOURS ?? "24", 10);
const FAV_MIN = 0.8, FAV_MAX = 0.95, CONC = 5;

let _e = false;
function loadEnv() { if (_e) return; _e = true; try { for (const l of fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf-8").split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); if (i < 0) continue; const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, ""); if (k && !(k in process.env)) process.env[k] = v; } } catch {} }
loadEnv();
function hdr(m: string, u: string): Record<string, string> { const a = process.env.KALSHI_API_KEY_ID ?? ""; const pp = process.env.KALSHI_PRIVATE_KEY_PEM_PATH ?? process.env.KALSHI_PRIVATE_KEY_PATH ?? ""; if (!a || !pp || !fs.existsSync(pp)) return {}; const pem = fs.readFileSync(pp, "utf-8"); const ts = Date.now().toString(); const s = crypto.createSign("SHA256"); s.update(ts + m.toUpperCase() + u); const sig = s.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, "base64"); return { "KALSHI-ACCESS-KEY": a, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig }; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(ep: string, p: Record<string, string>, retries = 4): Promise<any> {
  const qs = new URLSearchParams(p).toString();
  for (let a = 0; ; a++) {
    const r = await fetch(`${BASE}${ep}?${qs}`, { headers: { ...hdr("GET", PREFIX + ep), Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (r.ok) return r.json();
    if (r.status === 429 && a < retries) { await sleep(800 * 2 ** a); continue; }
    throw new Error(`HTTP ${r.status}`);
  }
}
const num = (v: unknown): number | null => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : null; };
function wilson(w: number, n: number, z = 1.96) { if (!n) return { lo: 0, hi: 1, p: 0 }; const ph = w / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt((ph * (1 - ph) + z * z / (4 * n)) / n); return { lo: (c - m) / d, hi: (c + m) / d, p: ph }; }

interface Fav { ticker: string; series: string; result: "yes" | "no"; closeMs: number; bid: number; ask: number; mid: number; }
interface Fill { ticker: string; result: "yes" | "no"; entryBid: number; filled: boolean; }

async function main() {
  const all = JSON.parse(fs.readFileSync(PRICED, "utf-8")) as Fav[];
  const favs = all.filter((m) => m.mid >= FAV_MIN && m.mid <= FAV_MAX && m.bid > 0 && m.series);
  console.log(`favorites to test: ${favs.length}`);

  const done: Record<string, Fill> = {};
  if (fs.existsSync(FILLS)) { for (const f of JSON.parse(fs.readFileSync(FILLS, "utf-8")) as Fill[]) done[f.ticker] = f; console.log(`resuming — ${Object.keys(done).length} already checked`); }
  const todo = favs.filter((m) => !(m.ticker in done));

  let idx = 0, n = 0;
  async function worker() {
    while (idx < todo.length) {
      const m = todo[idx++];
      const closeTs = Math.floor(m.closeMs / 1000);
      const entryTs = closeTs - HORIZON_HOURS * 3600;
      try {
        const cs = await get(`/series/${m.series}/markets/${m.ticker}/candlesticks`, { start_ts: String(entryTs), end_ts: String(closeTs), period_interval: "60" });
        let filled = false;
        for (const c of cs.candlesticks ?? []) {
          if (!(c.end_period_ts > entryTs && c.end_period_ts <= closeTs)) continue;
          const askLow = num(c.yes_ask?.low_dollars);
          const trLow = num(c.price?.low_dollars);
          const lo = Math.min(askLow ?? 1, trLow ?? 1);
          if (lo <= m.bid) { filled = true; break; } // ask came down to our resting bid → fill
        }
        done[m.ticker] = { ticker: m.ticker, result: m.result, entryBid: m.bid, filled };
      } catch { /* skip */ }
      if (++n % 50 === 0) { fs.writeFileSync(FILLS, JSON.stringify(Object.values(done))); process.stdout.write(`\r${n}/${todo.length} checked`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.writeFileSync(FILLS, JSON.stringify(Object.values(done)));
  process.stdout.write("\n");

  const rows = Object.values(done);
  const filled = rows.filter((r) => r.filled);
  const unfilled = rows.filter((r) => !r.filled);
  const wAll = wilson(rows.filter((r) => r.result === "yes").length, rows.length);
  const wF = wilson(filled.filter((r) => r.result === "yes").length, filled.length);
  const wU = wilson(unfilled.filter((r) => r.result === "yes").length, unfilled.length);

  // Filled-only maker EV (per contract, no fee): outcome - entryBid
  const pnls = filled.map((r) => (r.result === "yes" ? 1 : 0) - r.entryBid);
  const N = pnls.length, mean = pnls.reduce((s, v) => s + v, 0) / Math.max(1, N);
  const v = N > 1 ? pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (N - 1) : 0;
  const se = Math.sqrt(v / Math.max(1, N));
  const avgBid = filled.reduce((s, r) => s + r.entryBid, 0) / Math.max(1, N);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`ADVERSE-SELECTION TEST — resting buy at the bid, ${HORIZON_HOURS}h pre-close`);
  console.log("=".repeat(78));
  console.log(`favorites tested:   ${rows.length}`);
  console.log(`FILL RATE:          ${(filled.length / rows.length * 100).toFixed(1)}%  (${filled.length} filled, ${unfilled.length} missed)`);
  console.log(`\nwin% ALL favs:      ${(wAll.p * 100).toFixed(1)}% [${(wAll.lo * 100).toFixed(1)}-${(wAll.hi * 100).toFixed(1)}%]  n=${rows.length}`);
  console.log(`win% FILLED:        ${(wF.p * 100).toFixed(1)}% [${(wF.lo * 100).toFixed(1)}-${(wF.hi * 100).toFixed(1)}%]  n=${filled.length}   ← what we'd actually own`);
  console.log(`win% MISSED:        ${(wU.p * 100).toFixed(1)}% [${(wU.lo * 100).toFixed(1)}-${(wU.hi * 100).toFixed(1)}%]  n=${unfilled.length}   ← winners we never get`);
  const adverse = wAll.p - wF.p;
  console.log(`\nadverse selection:  filled win% is ${adverse >= 0 ? "" : "+"}${(-adverse * 100).toFixed(1)}pp ${adverse > 0.005 ? "BELOW" : "vs"} all-favs`);
  console.log(`\nREALIZED MAKER EDGE (filled-only, deployed capital):`);
  console.log(`  EV/contract = $${mean.toFixed(4)} ± ${se.toFixed(4)} (t=${(se > 0 ? mean / se : 0).toFixed(2)}) | ROI ${(avgBid > 0 ? mean / avgBid * 100 : 0).toFixed(2)}% | avg bid ${(avgBid * 100).toFixed(1)}¢`);
  console.log(`  vs assume-all-fill maker (the mirage): see flb-vs-picks (+6.43%)`);
  console.log(`\nVERDICT: ${(se > 0 && mean / se > 2 && mean > 0) ? "✓ edge SURVIVES realistic fills" : "✗ edge does NOT survive — adverse selection kills it"}`);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
