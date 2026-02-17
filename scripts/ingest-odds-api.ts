import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { getOptionalEnv, getRequiredEnv } from "../src/lib/server-env";

type OddsEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    key: string;
    title: string;
    markets?: Array<{ key: string; outcomes?: Array<{ name: string; price?: number; point?: number }> }>;
  }>;
};

const DEFAULT_LEAGUES = [
  "basketball_ncaab",
  "basketball_nba",
  "americanfootball_nfl",
  "baseball_mlb",
];

async function fetchOddsForLeague(
  apiKey: string,
  league: string,
  regions: string,
  markets: string,
  oddsFormat: string,
): Promise<{ events: OddsEvent[]; remaining: string; used: string }> {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${league}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", oddsFormat);

  const res = await fetch(url, {
    headers: { "User-Agent": "sports-betting-trends/1.0" },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.warn(`The Odds API request failed for ${league} (${res.status}): ${body.slice(0, 200)}`);
    return { events: [], remaining: "?", used: "?" };
  }

  const data = (await res.json()) as OddsEvent[];
  const remaining = res.headers.get("x-requests-remaining") ?? "unknown";
  const used = res.headers.get("x-requests-used") ?? "unknown";

  return { events: Array.isArray(data) ? data : [], remaining, used };
}

async function main() {
  const root = process.cwd();
  loadEnvConfig(root);

  const apiKey = getRequiredEnv("THE_ODDS_API_KEY");
  const regions = getOptionalEnv("THE_ODDS_REGIONS", "us")!;
  const markets = getOptionalEnv("THE_ODDS_MARKETS", "h2h,spreads")!;
  const oddsFormat = getOptionalEnv("THE_ODDS_ODDS_FORMAT", "american")!;

  // Allow env override of leagues
  const leaguesEnv = getOptionalEnv("THE_ODDS_LEAGUES", "");
  const leagues = leaguesEnv ? leaguesEnv.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_LEAGUES;

  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  const allEvents: OddsEvent[] = [];
  let lastRemaining = "unknown";
  let lastUsed = "unknown";

  for (const league of leagues) {
    const result = await fetchOddsForLeague(apiKey, league, regions, markets, oddsFormat);
    lastRemaining = result.remaining;
    lastUsed = result.used;

    if (result.events.length > 0) {
      // Write per-league file
      const leagueOutPath = path.join(outDir, `latest-odds-api-${league}.json`);
      fs.writeFileSync(
        leagueOutPath,
        JSON.stringify(
          {
            fetchedAt: new Date().toISOString(),
            league,
            regions,
            markets,
            eventCount: result.events.length,
            sampleEvent: {
              id: result.events[0]?.id,
              sport_key: result.events[0]?.sport_key,
              commence_time: result.events[0]?.commence_time,
              home_team: result.events[0]?.home_team,
              away_team: result.events[0]?.away_team,
            },
            events: result.events,
          },
          null,
          2,
        ),
      );
      console.log(`${league}: ${result.events.length} events → ${leagueOutPath}`);
    } else {
      console.log(`${league}: 0 events (may be off-season)`);
    }

    allEvents.push(...result.events);
  }

  // Write combined file for backward compatibility
  const combinedOutPath = path.join(outDir, "latest-odds-api.json");
  fs.writeFileSync(
    combinedOutPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        leagues: leagues.join(","),
        regions,
        markets,
        eventCount: allEvents.length,
        sampleEvent: allEvents[0]
          ? {
              id: allEvents[0].id,
              sport_key: allEvents[0].sport_key,
              commence_time: allEvents[0].commence_time,
              home_team: allEvents[0].home_team,
              away_team: allEvents[0].away_team,
            }
          : null,
        events: allEvents,
      },
      null,
      2,
    ),
  );

  console.log(`\nTotal: ${allEvents.length} events across ${leagues.length} leagues → ${combinedOutPath}`);
  console.log(`Quota headers: remaining=${lastRemaining}, used=${lastUsed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
