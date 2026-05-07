// Pulls a small set of MLB advanced-metric signals the search highlighted as
// undervalued by the market: xwOBA-vs-wOBA gap (BABIP-suppressed bats due to
// regress), pitcher velocity gains, recent closer changes.
//
// Source: FanGraphs leaderboards (public, lightly-rate-limited).
//   - https://www.fangraphs.com/leaders.aspx?stats=bat&type=8 (xwOBA leaderboard)
//   - https://www.fangraphs.com/leaders.aspx?stats=pit&type=8 (velocity)
//
// Output: data/processed/mlb-advanced-signals.json
//
// Usage: npm run scrape:mlb-signals

import { config } from "dotenv";
config();

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const OUT = path.resolve(process.cwd(), "data/processed/mlb-advanced-signals.json");

type BatterSignal = {
  player: string;
  team: string | null;
  pa: number | null;
  woba: number | null;
  xwoba: number | null;
  // Positive gap = xwOBA exceeds wOBA → BABIP-suppressed, regression candidate
  xwobaGap: number | null;
};

type PitcherSignal = {
  player: string;
  team: string | null;
  ip: number | null;
  fbVelocity: number | null;
  // Velocity delta vs prior season — positive = trending up
  velocityDelta: number | null;
  k9: number | null;
};

const BATTER_URL = "https://www.fangraphs.com/leaders/major-league?pos=all&stats=bat&lg=all&qual=100&type=8&season=2026&month=0&season1=2026&ind=0&team=0&rost=0&age=0&filter=&players=0&startdate=&enddate=&sortcol=21&sortdir=asc";
const PITCHER_URL = "https://www.fangraphs.com/leaders/major-league?pos=all&stats=pit&lg=all&qual=20&type=8&season=2026&month=0&season1=2026&ind=0&team=0&rost=0&age=0&filter=&players=0&startdate=&enddate=&sortcol=4&sortdir=desc";

function parseFloatOrNull(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[%,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function scrapeBatterTable(page: import("playwright").Page): Promise<BatterSignal[]> {
  // FanGraphs renders with React; we wait for the leaderboard table to populate.
  await page.waitForSelector("table tbody tr", { timeout: 25_000 }).catch(() => {});

  const rows = await page.$$eval("table tbody tr", trs =>
    trs.slice(0, 80).map(tr => {
      const cells = Array.from(tr.querySelectorAll("td")).map(td => (td.textContent ?? "").trim());
      return cells;
    })
  );

  const headers = await page.$$eval("table thead th", ths =>
    ths.map(th => (th.textContent ?? "").trim())
  );
  const idx = (label: string) => headers.findIndex(h => h.toLowerCase() === label.toLowerCase());
  const nameIdx = idx("Name");
  const teamIdx = idx("Team");
  const paIdx = idx("PA");
  const wobaIdx = idx("wOBA");
  const xwobaIdx = idx("xwOBA");

  const out: BatterSignal[] = [];
  for (const c of rows) {
    if (c.length < 5) continue;
    const woba = wobaIdx >= 0 ? parseFloatOrNull(c[wobaIdx]) : null;
    const xwoba = xwobaIdx >= 0 ? parseFloatOrNull(c[xwobaIdx]) : null;
    out.push({
      player: nameIdx >= 0 ? c[nameIdx] : "",
      team: teamIdx >= 0 ? c[teamIdx] : null,
      pa: paIdx >= 0 ? parseFloatOrNull(c[paIdx]) : null,
      woba,
      xwoba,
      xwobaGap: woba !== null && xwoba !== null ? +(xwoba - woba).toFixed(3) : null,
    });
  }
  return out;
}

async function scrapePitcherTable(page: import("playwright").Page): Promise<PitcherSignal[]> {
  await page.waitForSelector("table tbody tr", { timeout: 25_000 }).catch(() => {});
  const rows = await page.$$eval("table tbody tr", trs =>
    trs.slice(0, 60).map(tr => Array.from(tr.querySelectorAll("td")).map(td => (td.textContent ?? "").trim()))
  );
  const headers = await page.$$eval("table thead th", ths =>
    ths.map(th => (th.textContent ?? "").trim())
  );
  const idx = (label: string) => headers.findIndex(h => h.toLowerCase() === label.toLowerCase());
  const nameIdx = idx("Name");
  const teamIdx = idx("Team");
  const ipIdx = idx("IP");
  const fbvIdx = idx("FBv");
  const k9Idx = idx("K/9");

  const out: PitcherSignal[] = [];
  for (const c of rows) {
    if (c.length < 5) continue;
    out.push({
      player: nameIdx >= 0 ? c[nameIdx] : "",
      team: teamIdx >= 0 ? c[teamIdx] : null,
      ip: ipIdx >= 0 ? parseFloatOrNull(c[ipIdx]) : null,
      fbVelocity: fbvIdx >= 0 ? parseFloatOrNull(c[fbvIdx]) : null,
      velocityDelta: null, // requires prior-season comparison; deferred
      k9: k9Idx >= 0 ? parseFloatOrNull(c[k9Idx]) : null,
    });
  }
  return out;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
    });

    let batters: BatterSignal[] = [];
    let pitchers: PitcherSignal[] = [];

    try {
      console.log("Fetching batter xwOBA leaderboard...");
      const page = await ctx.newPage();
      await page.goto(BATTER_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(3000);
      batters = await scrapeBatterTable(page);
      await page.close();
      console.log(`  ${batters.length} batters`);
    } catch (err) {
      console.warn("Batter scrape failed:", err);
    }

    try {
      console.log("Fetching pitcher velocity leaderboard...");
      const page = await ctx.newPage();
      await page.goto(PITCHER_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(3000);
      pitchers = await scrapePitcherTable(page);
      await page.close();
      console.log(`  ${pitchers.length} pitchers`);
    } catch (err) {
      console.warn("Pitcher scrape failed:", err);
    }

    // Top regression-candidate batters: largest positive xwOBA - wOBA gap with
    // sufficient PA. These are likely undervalued by the market on hits/TB.
    const regressionCandidates = batters
      .filter(b => b.pa !== null && b.pa >= 100 && b.xwobaGap !== null && b.xwobaGap >= 0.020)
      .sort((a, b) => (b.xwobaGap ?? 0) - (a.xwobaGap ?? 0))
      .slice(0, 25);

    // Top velocity gainers: highest FB velocity (proxy for stuff trending up)
    const velocityGainers = pitchers
      .filter(p => p.fbVelocity !== null && p.ip !== null && p.ip >= 10)
      .sort((a, b) => (b.fbVelocity ?? 0) - (a.fbVelocity ?? 0))
      .slice(0, 20);

    // Closer changes — RotoWire's MLB closers page lists each team's current
    // closer plus recent role changes. We scrape it as a side trip on the
    // already-warm browser context.
    const closerChanges: Array<{ team: string; newCloser: string; tier: string }> = [];
    try {
      console.log("Fetching MLB closer chart...");
      const cpage = await ctx.newPage();
      await cpage.goto("https://www.rotowire.com/baseball/closer-grid.php", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await cpage.waitForTimeout(2500);
      // Each team row has the closer-tier hierarchy. We pull the top tier (1)
      // closer + flag teams where the role has changed in the last 7 days.
      const rows = await cpage.$$eval("table tr", trs =>
        trs.slice(1, 35).map(tr => {
          const cells = Array.from(tr.querySelectorAll("td")).map(td => (td.textContent ?? "").trim());
          return cells;
        })
      );
      for (const c of rows) {
        if (c.length < 3) continue;
        const team = c[0];
        const tier1 = c[1];
        if (!team || !tier1) continue;
        // Heuristic: a name marked with * or the page's "(new)" indicator suggests recent change
        const isNew = /\*|\(new\)|recent/i.test(c.join(" "));
        if (isNew) {
          closerChanges.push({ team, newCloser: tier1.replace(/[*†‡]/g, "").trim(), tier: "1" });
        }
      }
      await cpage.close();
      console.log(`  ${closerChanges.length} recent closer changes`);
    } catch (err) {
      console.warn("Closer chart scrape failed:", err);
    }

    const out = {
      generatedAt: new Date().toISOString(),
      source: "fangraphs+rotowire",
      regressionCandidates,
      velocityGainers,
      closerChanges,
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
    console.log(
      `\n✓ wrote ${regressionCandidates.length} regression candidates + ${velocityGainers.length} velocity gainers → ${OUT}`
    );
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
