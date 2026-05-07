// Logs the daily set of model-derived picks (heuristic best bets, scraped
// player props) to the ModelPickSnapshot table. Idempotent — the unique
// index on (source, snapshotDate, market, selection, player) prevents
// double-logging when the workflow runs twice in a day.

import fs from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROCESSED, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

type SummaryBestBet = {
  league: string;
  matchup: string;
  pickTeam: string;
  line: string | null;
  confidence: number;
  score: number;
  rationaleSignals: string[];
  gameDate: string | null;
  // Optional market type (moneyline | spread | total). When absent we infer
  // from the line string ("Over X" / "Under X" → total; numeric like "-4.5"
  // → spread; otherwise moneyline).
  market?: string;
};

// Infer the market type from a best-bet's line string. The summary's
// bestBets used to be ML-only, but spread/total picks now appear too —
// labeling them "moneyline" makes the snapshot grader produce meaningless
// W/L results.
function inferMarket(line: string | null | undefined, explicit?: string): string {
  if (explicit) {
    const m = explicit.toLowerCase();
    if (m.includes("total") || m.includes("over") || m.includes("under")) return "total";
    if (m.includes("spread") || m.includes("ats")) return "spread";
    if (m.includes("moneyline") || m.includes("ml")) return "moneyline";
  }
  if (!line) return "moneyline";
  const l = line.trim().toLowerCase();
  if (l.startsWith("over") || l.startsWith("under") || l.startsWith("o ") || l.startsWith("u ")) return "total";
  // Pure numeric with optional sign indicates a spread
  if (/^[+-]?\d+(\.\d+)?$/.test(l)) return "spread";
  return "moneyline";
}

type PropEntry = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  marketLabel?: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
};

export type LogResult = {
  marketPicksLogged: number;
  propsLogged: number;
  errors: string[];
};

async function logMarketPicks(): Promise<{ count: number; errors: string[] }> {
  const file = readJson<{ bestBets?: SummaryBestBet[] }>("latest-summary.json", { bestBets: [] });
  const today = utcDay();
  const errors: string[] = [];
  let logged = 0;

  for (const p of file.bestBets ?? []) {
    if (p.league !== "NBA" && p.league !== "MLB") continue;
    const market = inferMarket(p.line, p.market);
    // Build a selection that includes the line for spread/total so the grader
    // can disambiguate — e.g. "Lakers -4.5" vs the Lakers ML.
    const selection =
      market === "moneyline"
        ? p.pickTeam
        : market === "total"
        ? `${p.pickTeam} ${p.line ?? ""}`.trim()
        : `${p.pickTeam} ${p.line ?? ""}`.trim();
    const lineNum =
      typeof p.line === "string" && /-?\d+(\.\d+)?/.test(p.line)
        ? parseFloat(p.line.match(/-?\d+(\.\d+)?/)![0])
        : null;
    try {
      await prisma.modelPickSnapshot.upsert({
        where: {
          source_snapshotDate_market_selection_player: {
            source: "market",
            snapshotDate: today,
            market,
            selection,
            player: "", // empty string for the unique constraint (SQLite quirk: nulls aren't unique)
          },
        },
        create: {
          source: "market",
          league: p.league,
          snapshotDate: today,
          matchup: p.matchup,
          market,
          selection,
          line: lineNum,
          oddsAmerican: null,
          confidence: p.confidence,
          edge: null,
          rationaleSignals: JSON.stringify(p.rationaleSignals ?? []),
          player: "",
        },
        update: {
          confidence: p.confidence,
          rationaleSignals: JSON.stringify(p.rationaleSignals ?? []),
          line: lineNum,
        },
      });
      logged++;
    } catch (err) {
      errors.push(`market ${p.matchup}/${p.pickTeam}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { count: logged, errors };
}

async function logPlayerProps(): Promise<{ count: number; errors: string[] }> {
  const file = readJson<{ available?: boolean; topProps?: PropEntry[]; props?: PropEntry[] }>(
    "latest-player-props.json",
    {}
  );
  if (!file.available) return { count: 0, errors: [] };

  const today = utcDay();
  const errors: string[] = [];
  let logged = 0;

  // Log all props (not just top 5) so we have richer history
  const all = file.props ?? file.topProps ?? [];
  for (const p of all) {
    const oddsAm = p.pickSide === "over" ? p.overPrice : p.underPrice;
    try {
      await prisma.modelPickSnapshot.upsert({
        where: {
          source_snapshotDate_market_selection_player: {
            source: "prop_nba",
            snapshotDate: today,
            market: p.market,
            selection: `${p.pickSide.toUpperCase()} ${p.line}`,
            player: p.player,
          },
        },
        create: {
          source: "prop_nba",
          league: "NBA",
          snapshotDate: today,
          matchup: p.opponent ? `${p.team ?? "?"} vs ${p.opponent}` : null,
          market: p.market,
          selection: `${p.pickSide.toUpperCase()} ${p.line}`,
          line: p.line,
          oddsAmerican: oddsAm ?? null,
          confidence: p.confidence,
          edge: null,
          rationaleSignals: JSON.stringify(p.rationaleSignals ?? []),
          player: p.player,
          team: p.team,
          opponent: p.opponent,
          propType: p.market,
        },
        update: {
          confidence: p.confidence,
          oddsAmerican: oddsAm ?? null,
          rationaleSignals: JSON.stringify(p.rationaleSignals ?? []),
        },
      });
      logged++;
    } catch (err) {
      errors.push(`prop ${p.player}/${p.market}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { count: logged, errors };
}

export async function logTodaysSnapshots(): Promise<LogResult> {
  const market = await logMarketPicks();
  const props = await logPlayerProps();
  return {
    marketPicksLogged: market.count,
    propsLogged: props.count,
    errors: [...market.errors, ...props.errors],
  };
}
