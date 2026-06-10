/** Analyze-only: read the current flb-priced.json cache and print calibration +
 *  favorite-slice EV. Safe to run while the scrape continues. Safe to delete. */
import fs from "node:fs";
import path from "node:path";

const PRICED = path.resolve(process.cwd(), "data", "processed", "flb-priced.json");
const FAV_MIN = 0.8, FAV_MAX = 0.95;
const fee = (p: number) => 0.07 * p * (1 - p);

interface P { ticker: string; category: string; result: "yes" | "no"; closeMs: number; bid: number; ask: number; mid: number; }

function wilson(w: number, n: number, z = 1.96) {
  if (!n) return { lo: 0, hi: 1, p: 0 };
  const ph = w / n, d = 1 + z * z / n, c = ph + z * z / (2 * n);
  const m = z * Math.sqrt((ph * (1 - ph) + z * z / (4 * n)) / n);
  return { lo: (c - m) / d, hi: (c + m) / d, p: ph };
}
function ev(rows: P[], entry: (m: P) => number, f: (p: number) => number) {
  const pnls = rows.map((m) => (m.result === "yes" ? 1 : 0) - entry(m) - f(entry(m)));
  const n = pnls.length, mean = pnls.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const v = n > 1 ? pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(v / Math.max(1, n));
  const cost = rows.reduce((s, m) => s + entry(m), 0) / Math.max(1, n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, roi: cost > 0 ? mean / cost * 100 : 0, cost };
}

const all = (JSON.parse(fs.readFileSync(PRICED, "utf-8")) as P[]).filter((m) => m.mid > 0 && m.mid < 1);
console.log(`PRELIMINARY (priced so far: ${all.length})\n`);
console.log("bucket   |    n | win%  [95% CI]        | bias");
for (let lo = 0; lo < 1; lo += 0.1) {
  const rows = all.filter((m) => m.mid >= lo && m.mid < lo + 0.1);
  if (!rows.length) continue;
  const w = wilson(rows.filter((m) => m.result === "yes").length, rows.length);
  const mid = rows.reduce((s, m) => s + m.mid, 0) / rows.length;
  const bias = w.p - mid;
  console.log(`${(lo * 100).toFixed(0).padStart(2)}-${((lo + 0.1) * 100).toFixed(0)}¢  | ${String(rows.length).padStart(4)} | ${(w.p * 100).toFixed(1).padStart(5)}% [${(w.lo * 100).toFixed(0)}-${(w.hi * 100).toFixed(0)}%] | ${bias >= 0 ? "+" : ""}${(bias * 100).toFixed(1)}pp ${bias > 0.01 ? "UNDER" : bias < -0.01 ? "over" : ""}`);
}
const favs = all.filter((m) => m.mid >= FAV_MIN && m.mid <= FAV_MAX);
const fw = wilson(favs.filter((m) => m.result === "yes").length, favs.length);
console.log(`\nFAVORITE SLICE ${FAV_MIN}-${FAV_MAX}: n=${favs.length} win=${(fw.p * 100).toFixed(1)}% [${(fw.lo * 100).toFixed(1)}-${(fw.hi * 100).toFixed(1)}%] avgMid=${(favs.reduce((s, m) => s + m.mid, 0) / Math.max(1, favs.length) * 100).toFixed(1)}¢`);
const tk = ev(favs, (m) => m.ask, fee), mk = ev(favs, (m) => m.bid, () => 0);
console.log(`TAKER (buy ask): EV/contract=$${tk.mean.toFixed(4)} ±${tk.se.toFixed(4)} t=${tk.t.toFixed(2)} ROI=${tk.roi.toFixed(2)}% ${tk.t > 2 ? "✓SIG" : "✗"}`);
console.log(`MAKER (rest bid): EV/contract=$${mk.mean.toFixed(4)} ±${mk.se.toFixed(4)} t=${mk.t.toFixed(2)} ROI=${mk.roi.toFixed(2)}% ${mk.t > 2 ? "✓SIG" : "✗"}`);
