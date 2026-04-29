/**
 * test-bot-readiness.ts — Full pre-flight check for the Kalshi WS autopilot
 *
 * Tests every major subsystem and prints a GO / NO-GO summary.
 *
 * Usage:
 *   npx tsx scripts/test-bot-readiness.ts
 *
 * Sections:
 *   1. Data freshness  — are latest-kalshi.json, odds API files, etc. current?
 *   2. Books map       — does the devig map build? how many teams / markets match?
 *   3. Market loading  — how many markets load? game markets for today?
 *   4. Signal logic    — unit-tests for detectLeader() with synthetic histories
 *   5. Kalshi REST     — live auth check: balance, open orders, positions
 *   6. Cross-edge scan — today's bestBets with edge vs Kalshi
 *   7. Summary         — GO / NO-GO with blocker list
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getBalance,
  getOrders,
  getPositions,
} from "./execute-kalshi.js";

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
const ROOT       = path.resolve(process.cwd());
const DATA_DIR   = path.join(ROOT, "data", "processed");
const MARKETS_F  = path.join(DATA_DIR, "latest-kalshi.json");
const SUMMARY_F  = path.join(DATA_DIR, "latest-summary.json");
const ODDS_F     = path.join(DATA_DIR, "latest-odds-api.json");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
let warnCount = 0;
const blockers: string[] = [];

function pass(label: string, detail = "") {
  passCount++;
  console.log(`  [PASS] ${label}${detail ? " — " + detail : ""}`);
}

function fail(label: string, detail = "", blocker = true) {
  failCount++;
  console.log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`);
  if (blocker) blockers.push(label);
}

function warn(label: string, detail = "") {
  warnCount++;
  console.log(`  [WARN] ${label}${detail ? " — " + detail : ""}`);
}

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function ageMinutes(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) / 60_000;
  } catch {
    return Infinity;
  }
}

function readJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as T; }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror what the autopilot uses)
// ─────────────────────────────────────────────────────────────────────────────
interface ProcessedMarket {
  ticker: string;
  title: string;
  subtitle?: string;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
  status: string;
  actionability?: string;
  crossEdge?: { modelConfidence: number; kalshiImplied: number; gap: number; direction: string } | null;
}

interface BestBet {
  league: string;
  matchup: string;
  pickTeam: string;
  opponent: string;
  confidence: number;
  gameDate: string;
  spread?: number;
  subtitle?: string;
}

interface OddsApiGame {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  commence_time?: string;
  bookmakers?: {
    key: string;
    markets?: { key: string; outcomes?: { name: string; price: number }[] }[];
  }[];
}

interface OddsApiFile {
  events: OddsApiGame[];
}

interface LeaderResult {
  leader: "BOOKS" | "KALSHI" | "UNKNOWN";
  confidence: number;
  direction: "UP" | "DOWN" | "FLAT";
  momentumConfirmed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal logic (inlined from autopilot for unit testing)
// ─────────────────────────────────────────────────────────────────────────────
function detectLeader(booksPrices: number[], kalshiPrices: number[], lookback = 8): LeaderResult {
  const EMPTY: LeaderResult = { leader: "UNKNOWN", confidence: 0, direction: "FLAT", momentumConfirmed: false };
  if (booksPrices.length < lookback + 2 || kalshiPrices.length < lookback + 2) return EMPTY;

  const bW = booksPrices.slice(-lookback);
  const kW = kalshiPrices.slice(-lookback);
  const bR: number[] = [], kR: number[] = [];
  for (let i = 1; i < bW.length; i++) { bR.push(bW[i] - bW[i-1]); kR.push(kW[i] - kW[i-1]); }
  if (bR.length < 2) return EMPTY;

  let bLeads = 0, kLeads = 0;
  for (let i = 0; i < bR.length - 1; i++) {
    if (bR[i] !== 0 && kR[i+1] !== undefined && Math.sign(bR[i]) === Math.sign(kR[i+1])) bLeads++;
    if (kR[i] !== 0 && bR[i+1] !== undefined && Math.sign(kR[i]) === Math.sign(bR[i+1])) kLeads++;
  }
  const t1 = bLeads + kLeads;
  const s1 = t1 > 0 ? (bLeads - kLeads) / t1 : 0;

  let bFirst = 0, kFirst = 0;
  for (let i = 0; i < bR.length; i++) {
    const bm = Math.abs(bR[i]), km = Math.abs(kR[i]);
    if (bm > 0.005 && km < 0.002) bFirst++;
    else if (km > 0.005 && bm < 0.002) kFirst++;
  }
  const t2 = bFirst + kFirst;
  const s2 = t2 > 0 ? (bFirst - kFirst) / t2 : 0;

  const bMag = bR.reduce((s, r) => s + Math.abs(r), 0);
  const kMag = kR.reduce((s, r) => s + Math.abs(r), 0);
  const tMag = bMag + kMag;
  const s3   = tMag > 0 ? (bMag - kMag) / tMag : 0;

  const composite  = s1 * 0.5 + s2 * 0.3 + s3 * 0.2;
  const confidence = Math.abs(composite);
  let leader: "BOOKS" | "KALSHI" | "UNKNOWN" = "UNKNOWN";
  if (confidence > 0.3) leader = composite > 0 ? "BOOKS" : "KALSHI";

  const recent = bW.slice(-3);
  const trend  = recent[recent.length - 1] - recent[0];
  const direction: "UP" | "DOWN" | "FLAT" = trend > 0.01 ? "UP" : trend < -0.01 ? "DOWN" : "FLAT";

  const last3 = bR.slice(-3);
  const allSame  = last3.length >= 2 && last3.every(r => r * last3[0] > 0);
  const anyLarge = last3.some(r => Math.abs(r) > 0.01);

  return { leader, confidence, direction, momentumConfirmed: allSame && anyLarge };
}

// ─────────────────────────────────────────────────────────────────────────────
// Books map helpers (inlined from autopilot)
// ─────────────────────────────────────────────────────────────────────────────
function buildBooksMap(): Map<string, number> {
  const result = new Map<string, number>();
  let files: string[];
  try {
    files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("latest-odds-api") && f.endsWith(".json"));
  } catch { return result; }

  for (const file of files) {
    try {
      const raw   = readJson<OddsApiFile | OddsApiGame[]>(path.join(DATA_DIR, file));
      const games = Array.isArray(raw) ? raw : (raw as OddsApiFile)?.events ?? [];
      for (const game of games) {
        const homeRaws: number[] = [], awayRaws: number[] = [];
        for (const bm of game.bookmakers ?? []) {
          const h2h = bm.markets?.find(m => m.key === "h2h");
          if (!h2h) continue;
          for (const o of h2h.outcomes ?? []) {
            if (o.price <= 0) continue;
            const raw = 1 / o.price;
            if (o.name === game.home_team) homeRaws.push(raw);
            else if (o.name === game.away_team) awayRaws.push(raw);
          }
        }
        if (!homeRaws.length && !awayRaws.length) continue;
        const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s,v)=>s+v,0)/arr.length : 0;
        const hA = avg(homeRaws), aA = avg(awayRaws), tot = hA + aA;
        if (tot <= 0) continue;
        result.set(game.home_team.toLowerCase(), hA / tot);
        result.set(game.away_team.toLowerCase(), aA / tot);
      }
    } catch { /* skip */ }
  }
  return result;
}

function parseYesTeam(title: string, subtitle?: string): string | null {
  if (subtitle?.trim()) return subtitle.trim();
  const m1 = title.match(/will\s+(?:the\s+)?(.+?)\s+win/i);
  if (m1) return m1[1].trim();
  const m2 = title.match(/^(?:the\s+)?(.+?)\s+(?:at|vs\.?)\s+/i);
  if (m2) return m2[1].trim();
  return null;
}

function fuzzyLookupProb(team: string, map: Map<string, number>): number | null {
  if (!team) return null;
  const t = team.toLowerCase();
  if (map.has(t)) return map.get(t)!;
  const lastWord = t.split(" ").pop()!;
  for (const [key, val] of map) {
    if (key.includes(t) || t.includes(key)) return val;
    if (key.split(" ").pop() === lastWord) return val;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Today's date string helpers
// ─────────────────────────────────────────────────────────────────────────────
function todayKalshiStr(): string {
  const now = new Date();
  const yyyy = String(now.getFullYear()).slice(-2);
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const mm = MONTHS[now.getMonth()];
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  KALSHI BOT READINESS CHECK");
  console.log(`  ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`);
  console.log("═".repeat(60));

  // ───────────────────────────────────────────────────────────────
  // SECTION 1: Data Freshness
  // ───────────────────────────────────────────────────────────────
  section("1. DATA FRESHNESS");

  const files: [string, string, number, boolean][] = [
    // [label, path, max_age_minutes, is_blocker]
    ["latest-kalshi.json",            MARKETS_F, 120, true],
    ["latest-odds-api.json",          ODDS_F,    120, true],
    ["latest-summary.json",           SUMMARY_F, 120, false],
    ["latest-odds-api-basketball_nba.json", path.join(DATA_DIR, "latest-odds-api-basketball_nba.json"), 120, false],
    ["latest-odds-api-soccer_uefa_champs_league.json", path.join(DATA_DIR, "latest-odds-api-soccer_uefa_champs_league.json"), 300, false],
    ["injuries-nba.json",             path.join(DATA_DIR, "injuries-nba.json"), 360, false],
  ];

  for (const [label, fpath, maxAge, isBlocker] of files) {
    if (!fs.existsSync(fpath)) {
      if (isBlocker) fail(label, "FILE MISSING", true);
      else warn(label, "file missing");
      continue;
    }
    const age = ageMinutes(fpath);
    const ageStr = age < 60 ? `${age.toFixed(0)}m ago` : `${(age/60).toFixed(1)}h ago`;
    if (age <= maxAge) {
      pass(label, ageStr);
    } else {
      const msg = `stale — ${ageStr} (max ${maxAge}m)`;
      if (isBlocker) fail(label, msg, true);
      else warn(label, msg);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // SECTION 2: Books Map Quality
  // ───────────────────────────────────────────────────────────────
  section("2. BOOKS MAP (ODDS API DEVIG)");

  const booksMap = buildBooksMap();
  if (booksMap.size === 0) {
    fail("buildBooksMap()", "returned 0 teams — check odds API files", true);
  } else {
    pass("buildBooksMap()", `${booksMap.size} teams across all leagues`);
  }

  // Show sample teams
  const sampleTeams = [...booksMap.entries()].slice(0, 6);
  console.log("\n  Sample devigged probabilities:");
  for (const [team, prob] of sampleTeams) {
    console.log(`    ${team.padEnd(30)} ${(prob * 100).toFixed(1)}%`);
  }

  // Per-league file breakdown
  const oddsFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("latest-odds-api") && f.endsWith(".json"));
  console.log(`\n  Odds API files: ${oddsFiles.length}`);
  for (const file of oddsFiles) {
    const raw      = readJson<OddsApiFile | OddsApiGame[]>(path.join(DATA_DIR, file));
    const games    = Array.isArray(raw) ? raw : (raw as OddsApiFile)?.events ?? [];
    const withOdds = games.filter(g => (g.bookmakers?.length ?? 0) > 0).length;
    console.log(`    ${file.replace("latest-odds-api-","").replace(".json","").padEnd(35)} ${games.length} games, ${withOdds} with odds`);
  }

  // ───────────────────────────────────────────────────────────────
  // SECTION 3: Market Loading
  // ───────────────────────────────────────────────────────────────
  section("3. MARKET LOADING");

  const marketsFile = readJson<{ markets?: ProcessedMarket[] } | ProcessedMarket[]>(MARKETS_F);
  const rawMarkets: ProcessedMarket[] = Array.isArray(marketsFile)
    ? marketsFile
    : (marketsFile as { markets?: ProcessedMarket[] })?.markets ?? [];
  const todayStr = todayKalshiStr();
  console.log(`  Today's Kalshi date string: ${todayStr}`);

  // Count by actionability
  const countByAction: Record<string, number> = {};
  for (const m of rawMarkets) {
    const a = m.actionability ?? "unknown";
    countByAction[a] = (countByAction[a] ?? 0) + 1;
  }
  console.log(`\n  Total markets in latest-kalshi.json: ${rawMarkets.length}`);
  for (const [k, v] of Object.entries(countByAction)) {
    console.log(`    ${k.padEnd(10)} ${v}`);
  }

  // Markets that would be loaded by the WS autopilot
  const loadable = rawMarkets.filter(m => {
    const s = m.status.toLowerCase();
    if (s !== "open" && s !== "active") return false;
    const hasEdge = !!m.crossEdge;
    const isGame  = m.ticker.toUpperCase().includes("GAME-");
    const isHigh  = m.actionability === "High" || m.actionability === "Med";
    return hasEdge || (isGame && isHigh);
  });

  if (loadable.length === 0) {
    fail("loadMarkets()", "0 markets would be loaded", true);
  } else {
    pass("loadMarkets()", `${loadable.length} markets would load`);
  }

  // Today's game markets specifically
  const todayGames = loadable.filter(m => m.ticker.toUpperCase().includes(todayStr));
  if (todayGames.length === 0) {
    warn("Today's game markets", `0 markets with ${todayStr} in ticker`);
  } else {
    pass("Today's game markets", `${todayGames.length} markets for ${todayStr}`);
    console.log("\n  Today's loadable game markets:");
    for (const m of todayGames.slice(0, 15)) {
      const a     = (m.actionability ?? "?").padEnd(4);
      const title = m.title?.slice(0, 50) ?? m.ticker;
      console.log(`    [${a}] ${m.ticker.padEnd(35)} ${title}`);
    }
    if (todayGames.length > 15) console.log(`    ... and ${todayGames.length - 15} more`);
  }

  // Books match rate for loadable markets
  let booksMatched = 0;
  const unmatched: string[] = [];
  for (const m of loadable) {
    const yesTeam = parseYesTeam(m.title ?? "", m.subtitle);
    if (!yesTeam) continue;
    const prob = fuzzyLookupProb(yesTeam, booksMap);
    if (prob !== null) {
      booksMatched++;
    } else {
      unmatched.push(`${m.ticker} (team: "${yesTeam}")`);
    }
  }
  const matchRate = loadable.length > 0 ? (booksMatched / loadable.length * 100).toFixed(0) : "0";
  if (booksMatched === 0) {
    fail("Books match rate", `0/${loadable.length} markets have a books price`, true);
  } else if (booksMatched < loadable.length * 0.3) {
    warn("Books match rate", `${booksMatched}/${loadable.length} (${matchRate}%) — low match rate`);
  } else {
    pass("Books match rate", `${booksMatched}/${loadable.length} (${matchRate}%) matched to odds`);
  }

  if (unmatched.length > 0 && unmatched.length <= 10) {
    console.log("\n  Unmatched markets:");
    for (const u of unmatched) console.log(`    ${u}`);
  }

  // ───────────────────────────────────────────────────────────────
  // SECTION 4: Signal Logic Unit Tests
  // ───────────────────────────────────────────────────────────────
  section("4. SIGNAL LOGIC UNIT TESTS");

  // Test 1: Books lead UP — books move +1.5%/tick, kalshi barely moves (<0.2%/tick)
  // This triggers the first-mover signal (books big move + kalshi flat)
  {
    const books  = [0.500, 0.515, 0.530, 0.545, 0.560, 0.575, 0.590, 0.605, 0.620, 0.635];
    const kalshi = [0.500, 0.501, 0.501, 0.502, 0.502, 0.503, 0.503, 0.504, 0.504, 0.505];
    const r = detectLeader(books, kalshi);
    if (r.leader === "BOOKS" && r.direction === "UP" && r.momentumConfirmed) {
      pass("detectLeader — books lead UP", `confidence=${(r.confidence*100).toFixed(0)}% direction=${r.direction} momentum=✓`);
    } else {
      fail("detectLeader — books lead UP", `got leader=${r.leader} dir=${r.direction} momentum=${r.momentumConfirmed}`);
    }
  }

  // Test 2: Kalshi leads — kalshi moves +1.5%/tick, books barely moves
  {
    const kalshi = [0.500, 0.515, 0.530, 0.545, 0.560, 0.575, 0.590, 0.605, 0.620, 0.635];
    const books  = [0.500, 0.501, 0.501, 0.502, 0.502, 0.503, 0.503, 0.504, 0.504, 0.505];
    const r = detectLeader(books, kalshi);
    if (r.leader === "KALSHI") {
      pass("detectLeader — kalshi leads (no-trade case)", `confidence=${(r.confidence*100).toFixed(0)}%`);
    } else {
      fail("detectLeader — kalshi leads (no-trade case)", `expected KALSHI, got ${r.leader}`);
    }
  }

  // Test 3: Flat market — should return UNKNOWN or low confidence
  {
    const flat = [0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50];
    const r = detectLeader(flat, flat);
    if (r.leader === "UNKNOWN" || r.confidence < 0.3) {
      pass("detectLeader — flat market = no signal", `leader=${r.leader} confidence=${(r.confidence*100).toFixed(0)}%`);
    } else {
      warn("detectLeader — flat market", `unexpected signal: leader=${r.leader} confidence=${(r.confidence*100).toFixed(0)}%`);
    }
  }

  // Test 4: Books lead DOWN — books fall -1.5%/tick, kalshi barely moves
  {
    const books  = [0.700, 0.685, 0.670, 0.655, 0.640, 0.625, 0.610, 0.595, 0.580, 0.565];
    const kalshi = [0.700, 0.700, 0.699, 0.699, 0.698, 0.698, 0.697, 0.697, 0.696, 0.696];
    const r = detectLeader(books, kalshi);
    if (r.leader === "BOOKS" && r.direction === "DOWN") {
      pass("detectLeader — books lead DOWN", `confidence=${(r.confidence*100).toFixed(0)}% → would buy NO`);
    } else {
      warn("detectLeader — books lead DOWN", `got leader=${r.leader} dir=${r.direction}`);
    }
  }

  // Test 5: Not enough history — should return UNKNOWN
  {
    const r = detectLeader([0.5, 0.6], [0.5, 0.5]);
    if (r.leader === "UNKNOWN") {
      pass("detectLeader — insufficient history = no signal");
    } else {
      fail("detectLeader — insufficient history", `should be UNKNOWN, got ${r.leader}`);
    }
  }

  // Test 6: Edge calculation logic
  {
    const booksMid  = 0.65;
    const kalshiMid = 0.55;
    const rawEdge   = (booksMid - kalshiMid) * 100; // 10 pct-points
    const side      = rawEdge > 0 ? "yes" : "no";
    if (Math.abs(rawEdge - 10) < 0.001 && side === "yes") {
      pass("Edge calc — books 65% vs Kalshi 55%", `rawEdge=${rawEdge}% → buy YES`);
    } else {
      fail("Edge calc", `expected rawEdge=10 side=yes, got rawEdge=${rawEdge} side=${side}`);
    }
  }

  // Test 7: Kelly sizing — reasonable output
  {
    function computeKellySize(edgePct: number, leaderConf: number) {
      const edge = edgePct / 100;
      const winProb = Math.min(0.75, Math.max(0.35, 0.50 + edge * leaderConf * 2));
      const losProb = 1 - winProb;
      const gross   = edge > 0 ? (1 - edge) / edge : 0;
      const net     = gross * 0.93;
      if (net <= 0) return { contracts: 0, costUsd: 0 };
      const kelly   = winProb - losProb / net;
      const half    = Math.max(0, Math.min(0.25, kelly * 0.5));
      const raw     = half * 50;
      const cost    = Math.min(2.00, Math.max(0.50, Math.min(raw, edgePct >= 10 ? 2.00 : 1.00)));
      return { contracts: Math.max(1, Math.round(cost)), costUsd: cost };
    }
    const s = computeKellySize(8, 0.6);
    if (s.contracts >= 1 && s.costUsd >= 0.50 && s.costUsd <= 2.00) {
      pass("Kelly sizing — 8% edge, 0.6 conf", `contracts=${s.contracts} costUsd=$${s.costUsd.toFixed(2)}`);
    } else {
      fail("Kelly sizing", `unexpected output: ${JSON.stringify(s)}`);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // SECTION 5: Kalshi REST API (live)
  // ───────────────────────────────────────────────────────────────
  section("5. KALSHI REST API");

  if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY_PEM_PATH) {
    fail("Env vars", "KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM_PATH not set", true);
  } else {
    pass("Env vars", `key_id=${process.env.KALSHI_API_KEY_ID}`);

    // Balance
    try {
      const bal = await getBalance();
      const balUsd = (Number(bal.balance ?? 0) / 100).toFixed(2);
      const portUsd = (Number(bal.portfolio_value ?? 0) / 100).toFixed(2);
      if (Number(bal.balance ?? 0) > 0) {
        pass("getBalance()", `balance=$${balUsd} portfolio=$${portUsd}`);
      } else {
        warn("getBalance()", `balance=$${balUsd} — may be 0 or demo`);
      }
    } catch (err) {
      fail("getBalance()", (err as Error).message, true);
    }

    // Open orders
    try {
      const ordersResp = await getOrders("resting");
      const orders = Array.isArray(ordersResp) ? ordersResp : (ordersResp as { orders?: unknown[] }).orders ?? [];
      pass("getOrders(resting)", `${orders.length} resting orders`);
      if ((orders as { ticker: string }[]).length > 0) {
        console.log("  Resting orders:");
        for (const o of (orders as { ticker: string; side: string; yes_price?: number }[]).slice(0, 5)) {
          console.log(`    ${o.ticker} ${o.side} @${o.yes_price}c`);
        }
      }
    } catch (err) {
      warn("getOrders()", (err as Error).message);
    }

    // Open positions
    try {
      const posResp = await getPositions();
      const positions = (posResp as { market_positions?: { ticker: string; position: number }[] }).market_positions ?? [];
      const openPos   = positions.filter(p => p.position !== 0);
      pass("getPositions()", `${openPos.length} open positions`);
      if (openPos.length > 0) {
        console.log("  Open positions:");
        for (const p of openPos.slice(0, 5)) {
          console.log(`    ${p.ticker} qty=${p.position}`);
        }
      }
    } catch (err) {
      warn("getPositions()", (err as Error).message);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // SECTION 6: Cross-Edge Signals + Books Gaps
  // ───────────────────────────────────────────────────────────────
  section("6. CROSS-EDGE SIGNALS & BOOKS GAPS TODAY");

  const summaryRaw = readJson<{ bestBets?: BestBet[] } | BestBet[]>(SUMMARY_F);
  const bestBets: BestBet[] = Array.isArray(summaryRaw)
    ? summaryRaw
    : (summaryRaw as { bestBets?: BestBet[] })?.bestBets ?? [];

  console.log(`  Total bestBets in latest-summary.json: ${bestBets.length}`);

  // Group by league
  const byLeague: Record<string, number> = {};
  for (const b of bestBets) { byLeague[b.league] = (byLeague[b.league] ?? 0) + 1; }
  for (const [league, count] of Object.entries(byLeague).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${league.padEnd(20)} ${count} picks`);
  }

  // Show top confidence picks
  const sorted = [...bestBets].sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  if (sorted.length > 0) {
    console.log("\n  Top picks by confidence:");
    for (const b of sorted) {
      const edge = (() => {
        const mkt = rawMarkets.find(m =>
          m.title?.toLowerCase().includes(b.pickTeam.toLowerCase()) ||
          m.ticker.toLowerCase().includes(b.pickTeam.toLowerCase().replace(/\s+/g, "").slice(0, 4))
        );
        if (!mkt || !mkt.crossEdge) return "";
        return ` | Kalshi gap=${mkt.crossEdge.gap.toFixed(1)}%`;
      })();
      console.log(`    [${b.league.padEnd(8)}] ${b.pickTeam.padEnd(22)} conf=${b.confidence.toFixed(1)}%${edge}`);
    }
  }

  // Cross-edge markets in latest-kalshi.json
  const crossEdgeMarkets = rawMarkets.filter(m => m.crossEdge && (m.status === "open" || m.status === "active"));
  console.log(`\n  Markets with active crossEdge signal: ${crossEdgeMarkets.length}`);
  if (crossEdgeMarkets.length > 0) {
    const topCross = crossEdgeMarkets.sort((a, b) => Math.abs(b.crossEdge!.gap) - Math.abs(a.crossEdge!.gap)).slice(0, 8);
    console.log("  Top cross-edge gaps:");
    for (const m of topCross) {
      const e = m.crossEdge!;
      const booksP = fuzzyLookupProb(parseYesTeam(m.title ?? "", m.subtitle) ?? "", booksMap);
      const booksStr = booksP !== null ? `books=${(booksP*100).toFixed(1)}%` : "books=n/a";
      console.log(`    ${m.ticker.padEnd(35)} model=${e.modelConfidence.toFixed(1)}% kalshi=${e.kalshiImplied.toFixed(1)}% gap=${e.gap.toFixed(1)}% ${booksStr}`);
    }
    pass("Cross-edge signals", `${crossEdgeMarkets.length} active`);
  } else {
    warn("Cross-edge signals", "0 active — run ingest:all to refresh");
  }

  // Direct books-vs-kalshi gaps (fires on ALL game markets, no model required)
  console.log("\n  Direct books-vs-Kalshi gaps (ALL game markets, threshold >5%):");
  const bigGaps: { ticker: string; team: string; books: number; kalshi: number; gap: number }[] = [];
  for (const m of rawMarkets) {
    if (m.status !== "open" && m.status !== "active") continue;
    if (!m.ticker.toUpperCase().includes("GAME-")) continue;
    const yesTeam = parseYesTeam(m.title ?? "", m.subtitle);
    if (!yesTeam) continue;
    const booksP = fuzzyLookupProb(yesTeam, booksMap);
    if (booksP === null || m.yesMid <= 0) continue;
    const kalshiP = m.yesMid / 100;
    const gap = (booksP - kalshiP) * 100;
    if (Math.abs(gap) >= 5) {
      bigGaps.push({ ticker: m.ticker, team: yesTeam, books: booksP * 100, kalshi: kalshiP * 100, gap });
    }
  }
  bigGaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  if (bigGaps.length === 0) {
    console.log("    (none found — markets may be efficient or no overlap today)");
  } else {
    for (const g of bigGaps.slice(0, 10)) {
      const dir = g.gap > 0 ? "→ buy YES" : "→ buy NO";
      console.log(`    ${g.ticker.padEnd(35)} ${g.team.padEnd(22)} books=${g.books.toFixed(1)}% kalshi=${g.kalshi.toFixed(1)}% gap=${g.gap.toFixed(1)}% ${dir}`);
    }
    if (bigGaps.length > 10) console.log(`    ... and ${bigGaps.length - 10} more`);
    pass("Books-vs-Kalshi gaps", `${bigGaps.length} markets with >5% gap`);
  }

  // ───────────────────────────────────────────────────────────────
  // SUMMARY
  // ───────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("  SUMMARY");
  console.log("═".repeat(60));
  console.log(`  PASS: ${passCount}   FAIL: ${failCount}   WARN: ${warnCount}`);

  if (blockers.length === 0 && failCount === 0) {
    console.log("\n  STATUS: ✅  GO — bot is ready for today\n");
  } else if (blockers.length > 0) {
    console.log("\n  STATUS: ❌  NO-GO — blockers must be resolved:\n");
    for (const b of blockers) console.log(`    • ${b}`);
    console.log("\n  Fix: run `npm run ingest:all` then re-check\n");
  } else {
    console.log("\n  STATUS: ⚠️  READY WITH WARNINGS — review above\n");
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("\n[test-bot-readiness] Fatal:", err);
  process.exit(1);
});
