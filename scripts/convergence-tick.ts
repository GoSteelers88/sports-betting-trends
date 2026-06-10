/**
 * convergence-tick.ts — snapshot Kalshi vs Polymarket prices for curated
 * market pairs and append to the convergence log.
 *
 *   npm run convergence:tick            — snapshot all pairs
 *   npm run convergence:tick report     — spread summary per pair
 *   npm run convergence:discover "fed"  — side-by-side candidates for curation
 *
 * MEASUREMENT ONLY (Exp 4 candidate, not yet pre-registered as a book).
 * Pairs live in data/processed/venue-pairs.json and are HUMAN-CURATED —
 * the research's #1 trap is settlement-criteria mismatch between
 * identically-titled markets, so nothing enters the file automatically.
 * Cadence note: GH cron is ~2h granularity, so this measures PERSISTENT
 * divergence (hours), not fast arb windows (seconds-minutes) — the
 * one-legged question is whether Kalshi drifts toward Polymarket.
 */
import fs from "node:fs";
import path from "node:path";
import { fetchMarketStates } from "@/lib/kalshi/marketData";
import { fetchMarketBySlug, searchMarkets } from "@/lib/polymarket";

const DIR = path.join(process.cwd(), "data", "processed");
const PAIRS_FILE = path.join(DIR, "venue-pairs.json");
const LOG_FILE = path.join(DIR, "convergence-log.json");

interface VenuePair {
  label: string;
  kalshiTicker: string;
  polymarketSlug: string;
  rulesVerified: boolean; // human attests the resolution criteria match
  notes?: string;
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

async function discover(query: string) {
  console.log(`[convergence] Polymarket candidates for "${query}":`);
  const pm = await searchMarkets(query, 10);
  for (const m of pm) {
    console.log(`  PM  ${m.yesPrice != null ? (m.yesPrice * 100).toFixed(0) + "¢" : " —"}  ${m.question.slice(0, 90)}`);
    console.log(`      slug: ${m.slug} · ends ${m.endDate?.slice(0, 10) ?? "?"} · vol $${Math.round(m.volume).toLocaleString()}`);
  }
  console.log(
    `\nPair these with Kalshi tickers in ${path.relative(process.cwd(), PAIRS_FILE)} — ` +
      `READ BOTH RULE TEXTS first and set rulesVerified accordingly.`,
  );
}

function report() {
  const log = loadJson<{ ticks: any[] }>(LOG_FILE, { ticks: [] });
  const byPair = new Map<string, any[]>();
  for (const t of log.ticks) {
    if (!byPair.has(t.label)) byPair.set(t.label, []);
    byPair.get(t.label)!.push(t);
  }
  console.log(`convergence log — ${log.ticks.length} ticks across ${byPair.size} pairs`);
  for (const [label, ticks] of byPair) {
    const spreads = ticks
      .map((t) => t.spreadCents)
      .filter((s: number | null): s is number => s != null);
    if (spreads.length === 0) continue;
    const avg = spreads.reduce((s, x) => s + x, 0) / spreads.length;
    const max = Math.max(...spreads.map(Math.abs));
    console.log(
      `  ${label}: n=${spreads.length} avg spread ${avg.toFixed(1)}¢ (PM−Kalshi mid) · max |${max.toFixed(1)}¢|`,
    );
  }
}

async function tick() {
  const pairs = loadJson<VenuePair[]>(PAIRS_FILE, []);
  if (pairs.length === 0) {
    console.log(
      `[convergence] no pairs in ${path.relative(process.cwd(), PAIRS_FILE)} — ` +
        `run \`npm run convergence:discover "<topic>"\` to find candidates`,
    );
    return;
  }
  const kalshiStates = await fetchMarketStates(pairs.map((p) => p.kalshiTicker));
  const ts = new Date().toISOString();
  const log = loadJson<{ ticks: any[] }>(LOG_FILE, { ticks: [] });
  let appended = 0;

  for (const pair of pairs) {
    try {
      const k = kalshiStates.get(pair.kalshiTicker);
      const pm = await fetchMarketBySlug(pair.polymarketSlug);
      const kalshiBid = k?.yesBid ?? null;
      const pmYes = pm?.yesPrice ?? null;
      const spreadCents =
        kalshiBid != null && pmYes != null ? +((pmYes - kalshiBid) * 100).toFixed(1) : null;
      log.ticks.push({
        ts,
        label: pair.label,
        kalshiTicker: pair.kalshiTicker,
        polymarketSlug: pair.polymarketSlug,
        rulesVerified: pair.rulesVerified,
        kalshiBid,
        kalshiStatus: k?.status ?? null,
        pmYes,
        spreadCents,
      });
      appended++;
      console.log(
        `[convergence] ${pair.label}: Kalshi bid ${kalshiBid != null ? (kalshiBid * 100).toFixed(0) + "¢" : "—"} | ` +
          `PM yes ${pmYes != null ? (pmYes * 100).toFixed(0) + "¢" : "—"} | spread ${spreadCents ?? "—"}¢`,
      );
    } catch (err) {
      console.warn(`[convergence] ${pair.label} failed: ${(err as Error).message}`);
    }
  }

  if (appended > 0) fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 1));
  console.log(`[convergence] appended ${appended}/${pairs.length} pair snapshots`);
}

const arg = process.argv[2];
if (arg === "report") report();
else if (arg && arg !== "tick") discover(arg);
else tick();
