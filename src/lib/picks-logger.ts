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
};

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
    try {
      await prisma.modelPickSnapshot.upsert({
        where: {
          source_snapshotDate_market_selection_player: {
            source: "market",
            snapshotDate: today,
            market: "moneyline", // best-bets are team picks; bucket as moneyline for now
            selection: p.pickTeam,
            player: "", // empty string for the unique constraint (Prisma quirk: nulls aren't unique)
          },
        },
        create: {
          source: "market",
          league: p.league,
          snapshotDate: today,
          matchup: p.matchup,
          market: "moneyline",
          selection: p.pickTeam,
          line: null,
          oddsAmerican: null,
          confidence: p.confidence,
          edge: null,
          rationaleSignals: JSON.stringify(p.rationaleSignals ?? []),
          player: "",
        },
        update: {
          // Refresh confidence + signals if the heuristic re-ranked it
          confidence: p.confidence,
          rationaleSignals: JSON.stringify(p.rationaleSignals ?? []),
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
