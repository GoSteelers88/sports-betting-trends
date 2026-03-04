/**
 * backtest-model.ts — Evaluate model accuracy over last 30 days of completed games.
 *
 * Algorithm:
 *   1. Load kalshi-trades.jsonl — find all "filled" or "closed" entries
 *   2. For each trade, extract the game (teams + date) from the ticker
 *   3. Fetch ESPN scoreboard for that date to get actual result
 *   4. Determine if the pick team won
 *   5. Aggregate accuracy, avg spread error, ROI
 *
 * Output: data/processed/backtest-results.json
 * Usage: npm run backtest:model
 */

import fs from "node:fs";
import path from "node:path";

// Load .env (best-effort)
try {
  const envFile = path.resolve(process.cwd(), ".env");
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch { /* no .env */ }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeRecord {
  timestamp: string;
  ticker: string;
  side: "yes" | "no";
  edgePct?: number;
  status: "entry_placed" | "filled" | "closed" | "entry_timeout" | "cancelled";
  pnlUsd?: number;
  entryPriceDollars?: string;
  count_fp?: string;
  positionType?: "game" | "tournament";
}

interface EspnGame {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  date: string;           // YYYY-MM-DD
  league: "nba" | "nfl" | "ncaab";
}

export interface BacktestResults {
  generatedAt: string;
  lookbackDays: number;
  gamesTracked: number;
  winnerAccuracy: number;    // 0-1
  avgSpreadError: number;    // points
  roi: number;               // fraction
  totalPnlUsd: number;
  totalCostUsd: number;
  byLeague: Record<string, { accuracy: number; games: number; roi: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

// ---------------------------------------------------------------------------
// ESPN scoreboard fetch
// ---------------------------------------------------------------------------

type EspnScoreboard = {
  events?: Array<{
    id: string;
    date: string;
    competitions?: Array<{
      status?: { type?: { completed?: boolean } };
      competitors?: Array<{
        homeAway?: "home" | "away";
        score?: string;
        team?: { displayName?: string; shortDisplayName?: string };
      }>;
    }>;
  }>;
};

async function fetchEspnScoreboard(sport: string, league: string, date: Date): Promise<EspnGame[]> {
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard` +
    `?dates=${dateStr(date)}&limit=30`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as EspnScoreboard;
    const games: EspnGame[] = [];

    for (const event of data.events ?? []) {
      const comp = event.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;

      const competitors = comp.competitors ?? [];
      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");
      if (!home || !away) continue;

      const homeScore = parseFloat(home.score ?? "0");
      const awayScore = parseFloat(away.score ?? "0");
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

      games.push({
        homeTeam: home.team?.displayName ?? home.team?.shortDisplayName ?? "",
        awayTeam: away.team?.displayName ?? away.team?.shortDisplayName ?? "",
        homeScore,
        awayScore,
        date: event.date?.slice(0, 10) ?? "",
        league: league as EspnGame["league"],
      });
    }

    return games;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Ticker → league + teams parser
// ---------------------------------------------------------------------------

// Example tickers: KXNBAGAME-26MAR03NOPLAL-LAL, KXNFLGAME-...
function parseGameTicker(ticker: string): {
  league: "nba" | "nfl" | "ncaab" | null;
  dateStr: string | null;
  teamSuffix: string | null;
} {
  const upper = ticker.toUpperCase();

  let league: "nba" | "nfl" | "ncaab" | null = null;
  if (upper.startsWith("KXNBA")) league = "nba";
  else if (upper.startsWith("KXNFL")) league = "nfl";
  else if (upper.startsWith("KXNCAA")) league = "ncaab";

  if (!league) return { league: null, dateStr: null, teamSuffix: null };

  // Date embedded in ticker: e.g. "26MAR03" → parse to YYYYMMDD
  const dateMatch = upper.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/);
  const MONTHS: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  let parsedDate: string | null = null;
  if (dateMatch) {
    const year = `20${dateMatch[1]}`;
    const month = MONTHS[dateMatch[2]];
    const day = dateMatch[3].padStart(2, "0");
    parsedDate = `${year}-${month}-${day}`;
  }

  // Team suffix is the last hyphen-separated segment
  const parts = ticker.split("-");
  const teamSuffix = parts.at(-1) ?? null;

  return { league, dateStr: parsedDate, teamSuffix };
}

// Fuzzy team name matching: check if a suffix (e.g. "OKC") appears in a full name
function teamMatches(teamFullName: string, suffix: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normFull = norm(teamFullName);
  const normSuffix = norm(suffix);
  if (normFull === normSuffix) return true;
  if (normFull.includes(normSuffix) && normSuffix.length >= 3) return true;
  // Check abbreviation: "OKC" → "oklahoma city thunder" contains "okc" in abbr
  const words = teamFullName.split(/\s+/);
  const abbr = words.map((w) => w[0]).join("").toLowerCase();
  if (abbr === normSuffix && normSuffix.length >= 2) return true;
  // Last word of team name
  const lastWord = norm(words.at(-1) ?? "");
  if (lastWord === normSuffix && normSuffix.length >= 3) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = process.cwd();
  const processedDir = path.join(root, "data", "processed");
  const LOOKBACK_DAYS = 30;

  console.log(`[backtest] Evaluating model accuracy over last ${LOOKBACK_DAYS} days...`);

  // Load trade log
  const tradesPath = path.join(processedDir, "kalshi-trades.jsonl");
  if (!fs.existsSync(tradesPath)) {
    console.warn("[backtest] kalshi-trades.jsonl not found — no trades to evaluate.");
    fs.mkdirSync(processedDir, { recursive: true });
    const empty: BacktestResults = {
      generatedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      gamesTracked: 0,
      winnerAccuracy: 0.5,
      avgSpreadError: 0,
      roi: 0,
      totalPnlUsd: 0,
      totalCostUsd: 0,
      byLeague: {},
    };
    fs.writeFileSync(path.join(processedDir, "backtest-results.json"), JSON.stringify(empty, null, 2));
    console.log("[backtest] Wrote empty results.");
    return;
  }

  const rawLines = fs.readFileSync(tradesPath, "utf-8").split("\n").filter(Boolean);
  const trades: TradeRecord[] = [];
  for (const line of rawLines) {
    try { trades.push(JSON.parse(line) as TradeRecord); } catch { /* skip corrupt */ }
  }

  // Filter to game trades (not tournament) with meaningful status
  const cutoff = Date.now() - LOOKBACK_DAYS * 86400_000;
  const gameTrades = trades.filter((t) => {
    if (t.positionType === "tournament") return false;
    if (t.status !== "filled" && t.status !== "closed") return false;
    return new Date(t.timestamp).getTime() > cutoff;
  });

  console.log(`[backtest] ${gameTrades.length} game trades in last ${LOOKBACK_DAYS} days.`);

  if (gameTrades.length === 0) {
    const empty: BacktestResults = {
      generatedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      gamesTracked: 0,
      winnerAccuracy: 0.5,
      avgSpreadError: 0,
      roi: 0,
      totalPnlUsd: 0,
      totalCostUsd: 0,
      byLeague: {},
    };
    fs.writeFileSync(path.join(processedDir, "backtest-results.json"), JSON.stringify(empty, null, 2));
    console.log("[backtest] No game trades to evaluate. Wrote empty results.");
    return;
  }

  // Dedupe by ticker (keep most recent per ticker)
  const byTicker = new Map<string, TradeRecord>();
  for (const t of gameTrades) {
    const existing = byTicker.get(t.ticker);
    if (!existing || new Date(t.timestamp) > new Date(existing.timestamp)) {
      byTicker.set(t.ticker, t);
    }
  }

  // Build date → list of ESPN games cache
  type LeagueDayKey = `${string}:${string}`;
  const espnCache = new Map<LeagueDayKey, EspnGame[]>();

  const SPORT_FOR_LEAGUE: Record<string, string> = {
    nba: "basketball",
    nfl: "football",
    ncaab: "basketball",
  };
  const LEAGUE_FOR_SPORT: Record<string, string> = {
    nba: "nba",
    nfl: "nfl",
    ncaab: "college-basketball",
  };

  let correct = 0;
  let total = 0;
  let totalPnl = 0;
  let totalCost = 0;
  const spreadErrors: number[] = [];
  const byLeague: Record<string, { correct: number; total: number; pnl: number; cost: number }> = {};

  for (const [ticker, trade] of byTicker) {
    const { league, dateStr: gameDate, teamSuffix } = parseGameTicker(ticker);
    if (!league || !gameDate || !teamSuffix) continue;

    const cacheKey: LeagueDayKey = `${league}:${gameDate}`;
    if (!espnCache.has(cacheKey)) {
      const sport = SPORT_FOR_LEAGUE[league];
      const leagueName = LEAGUE_FOR_SPORT[league];
      if (!sport || !leagueName) continue;

      const games = await fetchEspnScoreboard(sport, leagueName, new Date(gameDate));
      espnCache.set(cacheKey, games);
      await sleep(300); // be kind to ESPN's API
    }

    const dayGames = espnCache.get(cacheKey) ?? [];

    // Find the game where the pick team played
    const game = dayGames.find((g) =>
      teamMatches(g.homeTeam, teamSuffix) || teamMatches(g.awayTeam, teamSuffix),
    );

    if (!game) continue;

    // Determine which team our trade was on (YES = team in ticker suffix)
    const pickIsHome = teamMatches(game.homeTeam, teamSuffix);
    const pickWon = pickIsHome
      ? game.homeScore > game.awayScore
      : game.awayScore > game.homeScore;

    // Did we bet YES on this team?
    const boughtYes = trade.side === "yes";
    const modelCorrect = boughtYes ? pickWon : !pickWon;

    const lg = byLeague[league] ?? { correct: 0, total: 0, pnl: 0, cost: 0 };
    lg.total++;
    if (modelCorrect) lg.correct++;
    if (trade.pnlUsd != null) lg.pnl += trade.pnlUsd;
    const costUsd = trade.entryPriceDollars != null && trade.count_fp != null
      ? parseFloat(trade.entryPriceDollars) * parseFloat(trade.count_fp)
      : 0;
    lg.cost += costUsd;
    byLeague[league] = lg;

    correct += modelCorrect ? 1 : 0;
    total++;
    totalPnl += trade.pnlUsd ?? 0;
    totalCost += costUsd;

    // Spread error (approximate: |edgePct| as proxy for spread confidence)
    if (trade.edgePct != null) {
      spreadErrors.push(Math.abs(trade.edgePct));
    }
  }

  const winnerAccuracy = total > 0 ? correct / total : 0.5;
  const avgSpreadError = spreadErrors.length > 0
    ? spreadErrors.reduce((s, v) => s + v, 0) / spreadErrors.length
    : 0;
  const roi = totalCost > 0 ? totalPnl / totalCost : 0;

  const byLeagueOut: BacktestResults["byLeague"] = {};
  for (const [lg, { correct: lc, total: lt, pnl: lp, cost: lcs }] of Object.entries(byLeague)) {
    byLeagueOut[lg] = {
      accuracy: lt > 0 ? lc / lt : 0,
      games: lt,
      roi: lcs > 0 ? lp / lcs : 0,
    };
  }

  const results: BacktestResults = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    gamesTracked: total,
    winnerAccuracy,
    avgSpreadError,
    roi,
    totalPnlUsd: totalPnl,
    totalCostUsd: totalCost,
    byLeague: byLeagueOut,
  };

  fs.mkdirSync(processedDir, { recursive: true });
  const outPath = path.join(processedDir, "backtest-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log(`[backtest] Written: ${outPath}`);
  console.log(
    `[backtest] Games: ${total} | Accuracy: ${(winnerAccuracy * 100).toFixed(1)}% | ` +
    `Avg spread err: ${avgSpreadError.toFixed(1)}% | ROI: ${(roi * 100).toFixed(1)}%`,
  );

  if (total < 10) {
    console.log("[backtest] Warning: fewer than 10 games — results may not be statistically meaningful.");
  }
}

main().catch((err) => {
  console.error("[backtest] Fatal:", err);
  process.exit(1);
});
