// Scrape NBA player props from RotoWire by parsing their inline JSON data.
//
// RotoWire's NBA props page (https://www.rotowire.com/betting/nba/player-props.php)
// embeds prop data inline as `data: [...]` arrays inside per-stat <script> blocks
// (one block per prop: pts, reb, ast, threes, blk, stl, to, pra, pr, pa, ra).
// Each row has the same player keyed by sportsbook, e.g.
//   draftkings_pts, draftkings_ptsOver, draftkings_ptsUnder
//
// We compute:
//   - consensus line  = median of book lines for that player
//   - over/under price = median of book prices on each side
//   - confidence      = inverse of book disagreement (tighter = higher conf)
//   - pickSide        = side with the better no-vig fair price across books
//
// Output: data/processed/latest-player-props.json (existing PlayerProps shape)

import { config } from "dotenv";
config();

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const URL = "https://www.rotowire.com/betting/nba/player-props.php";
const OUT = path.resolve(process.cwd(), "data/processed/latest-player-props.json");

type Category = "core" | "defense" | "combo";

const PROPS: Array<{ short: string; market: string; label: string; category: Category }> = [
  { short: "pts",       market: "player_points",                  label: "Points",        category: "core" },
  { short: "reb",       market: "player_rebounds",                label: "Rebounds",      category: "core" },
  { short: "ast",       market: "player_assists",                 label: "Assists",       category: "core" },
  { short: "threes",    market: "player_threes",                  label: "Threes",        category: "core" },
  { short: "blk",       market: "player_blocks",                  label: "Blocks",        category: "defense" },
  { short: "stl",       market: "player_steals",                  label: "Steals",        category: "defense" },
  { short: "turnovers", market: "player_turnovers",               label: "Turnovers",     category: "defense" },
  { short: "ptsrebast", market: "player_points_rebounds_assists", label: "Pts+Reb+Ast",   category: "combo" },
  { short: "ptsreb",    market: "player_points_rebounds",         label: "Pts+Reb",       category: "combo" },
  { short: "ptsast",    market: "player_points_assists",          label: "Pts+Ast",       category: "combo" },
  { short: "rebast",    market: "player_rebounds_assists",        label: "Reb+Ast",       category: "combo" },
  { short: "stlblk",    market: "player_blocks_steals",           label: "Stl+Blk",       category: "combo" },
];

const BOOKS = ["draftkings", "fanduel", "mgm", "betrivers", "caesars", "hardrock", "fanatics", "thescore"];

type RawPlayerRow = {
  name: string;
  team: string;
  opp: string;
  [bookKey: string]: string | null;
};

type PropOut = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  marketLabel: string;
  category: Category;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function americanToImplied(p: number): number {
  return p > 0 ? 100 / (p + 100) : -p / (-p + 100);
}

function parseAm(v: string | null | undefined): number | null {
  if (!v || v === "null" || v.trim() === "") return null;
  const n = parseFloat(v.replace("−", "-"));
  return Number.isFinite(n) ? n : null;
}

function parseLine(v: string | null | undefined): number | null {
  if (!v || v === "null" || v.trim() === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Extract the `data: [...]` array out of a script block. Uses a balanced-bracket
// scan rather than regex, since the array can contain nested objects with `]`.
function extractDataArray(scriptText: string): string | null {
  const marker = "data:";
  const idx = scriptText.indexOf(marker);
  if (idx < 0) return null;
  let i = scriptText.indexOf("[", idx);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  let strChar = "";
  let escaped = false;
  for (; i < scriptText.length; i++) {
    const ch = scriptText[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return scriptText.slice(start, i + 1);
    }
  }
  return null;
}

function rowsToProps(
  rows: RawPlayerRow[],
  prop: (typeof PROPS)[number]
): PropOut[] {
  const out: PropOut[] = [];
  for (const row of rows) {
    const lines: number[] = [];
    const overs: number[] = [];
    const unders: number[] = [];
    for (const book of BOOKS) {
      const lineKey = `${book}_${prop.short}`;
      const overKey = `${book}_${prop.short}Over`;
      const underKey = `${book}_${prop.short}Under`;
      const line = parseLine(row[lineKey] as string | null);
      const over = parseAm(row[overKey] as string | null);
      const under = parseAm(row[underKey] as string | null);
      if (line !== null) lines.push(line);
      if (over !== null) overs.push(over);
      if (under !== null) unders.push(under);
    }
    if (lines.length === 0) continue;

    const consensusLine = median(lines);
    const overPrice = overs.length ? Math.round(median(overs)) : null;
    const underPrice = unders.length ? Math.round(median(unders)) : null;

    // pickSide: take whichever has the lower no-vig implied prob (better EV)
    let pickSide: "over" | "under" = "over";
    if (overPrice !== null && underPrice !== null) {
      const overImp = americanToImplied(overPrice);
      const underImp = americanToImplied(underPrice);
      pickSide = overImp <= underImp ? "over" : "under";
    } else if (underPrice !== null && overPrice === null) {
      pickSide = "under";
    }

    // confidence: tighter line spread across books = higher confidence
    const lineSpread = Math.max(...lines) - Math.min(...lines);
    const baseConf = Math.max(0, 100 - lineSpread * 20); // 0.5 line spread => 90; 1.0 => 80
    const confidence = Math.round(Math.min(95, Math.max(35, baseConf)));

    const opp = (row.opp ?? "").toString();
    const cleanOpp = opp.startsWith("@") ? opp.slice(1) : opp;

    out.push({
      player: row.name,
      team: row.team || null,
      opponent: cleanOpp || null,
      market: prop.market,
      marketLabel: prop.label,
      category: prop.category,
      line: consensusLine,
      overPrice,
      underPrice,
      pickSide,
      confidence,
      rationaleSignals: [
        `${lines.length}-book consensus line ${consensusLine} (spread ${lineSpread.toFixed(1)})`,
      ],
    });
  }
  return out;
}

async function scrape(): Promise<{ scripts: Map<string, string> }> {
  console.log(`Fetching ${URL} ...`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const scripts = await page.evaluate(() => {
    const out: Array<{ key: string; text: string }> = [];
    for (const s of Array.from(document.querySelectorAll("script"))) {
      const text = s.textContent ?? "";
      const m = text.match(/const\s+prop\s*=\s*"([^"]+)"/);
      if (m && text.includes("loadTableRW")) {
        out.push({ key: m[1], text });
      }
    }
    return out;
  });

  await browser.close();

  const map = new Map<string, string>();
  for (const { key, text } of scripts) map.set(key, text);
  return { scripts: map };
}

async function main() {
  const { scripts } = await scrape();
  console.log(`Found ${scripts.size} prop scripts:`, [...scripts.keys()].join(", "));

  const allProps: PropOut[] = [];
  for (const prop of PROPS) {
    const script = scripts.get(prop.short);
    if (!script) {
      console.log(`  ${prop.short}: skip (no script)`);
      continue;
    }
    const arrayText = extractDataArray(script);
    if (!arrayText) {
      console.log(`  ${prop.short}: skip (no data array)`);
      continue;
    }
    let rows: RawPlayerRow[];
    try {
      rows = JSON.parse(arrayText) as RawPlayerRow[];
    } catch (err) {
      console.log(`  ${prop.short}: parse failed: ${err}`);
      continue;
    }
    const propsForThis = rowsToProps(rows, prop);
    console.log(`  ${prop.short}: ${rows.length} rows → ${propsForThis.length} props`);
    allProps.push(...propsForThis);
  }

  allProps.sort((a, b) => b.confidence - a.confidence);

  const out = {
    generatedAt: new Date().toISOString(),
    sport: "NBA",
    source: "rotowire",
    available: allProps.length > 0,
    topProps: allProps.slice(0, 5),
    props: allProps.slice(0, 200),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log(`\n✓ wrote ${out.props.length} props (top ${out.topProps.length}) → ${OUT}`);
}

main().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
