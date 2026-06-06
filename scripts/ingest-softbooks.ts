/**
 * Multi-book SOFT-price feed via The Odds API.
 *
 * The de-vigged-sharp pivot needs the BEST price across as many soft books as
 * possible — that's where +EV vs the sharp line actually lives. Scraping
 * DraftKings/BetMGM directly is blocked by Akamai bot protection, so we use
 * The Odds API which returns ~12-16 US books (DK, FanDuel, BetMGM, ESPN BET,
 * BetRivers, Hard Rock, …) in a single cheap call.
 *
 * Writes a SEPARATE file from scrape-odds.ts (latest-odds-api-*.json) so the
 * two never clobber each other. `fair-value.ts` merges both soft sources.
 *
 *   npm run ingest:softbooks            # NBA + MLB, regions=us (1 credit/sport)
 *   THE_ODDS_REGIONS=us,us2 npm run ingest:softbooks   # more books, 2 credits/sport
 *
 * Output: data/processed/latest-softbooks-{sport}.json
 * Cost: 1 credit per sport per region-set per call (h2h only). Free tier = 500/mo.
 */
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
    title?: string;
    markets?: Array<{
      key: string;
      outcomes?: Array<{ name: string; price?: number; point?: number }>;
    }>;
  }>;
};

// Sport keys must match what fair-value.ts / scrape-odds.ts use for filenames.
const SPORTS = ["baseball_mlb", "basketball_nba"] as const;

async function fetchSport(
  apiKey: string,
  sport: string,
  regions: string,
): Promise<{ events: OddsEvent[]; remaining: string; used: string }> {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "american");

  const res = await fetch(url, {
    headers: { "User-Agent": "sports-betting-trends/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`Odds API ${sport} (${res.status}): ${body.slice(0, 160)}`);
    return { events: [], remaining: "?", used: "?" };
  }
  const data = (await res.json()) as OddsEvent[];
  return {
    events: Array.isArray(data) ? data : [],
    remaining: res.headers.get("x-requests-remaining") ?? "?",
    used: res.headers.get("x-requests-used") ?? "?",
  };
}

async function main() {
  const root = process.cwd();
  loadEnvConfig(root);
  const apiKey = getRequiredEnv("THE_ODDS_API_KEY");
  const regions = getOptionalEnv("THE_ODDS_REGIONS", "us")!;
  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  let lastRemaining = "?";
  for (const sport of SPORTS) {
    const { events, remaining, used } = await fetchSport(apiKey, sport, regions);
    lastRemaining = remaining;
    if (events.length === 0) {
      console.warn(`${sport}: 0 events — leaving existing softbooks file in place`);
      continue;
    }
    const bookSet = new Set<string>();
    for (const e of events) for (const b of e.bookmakers ?? []) bookSet.add(b.key);

    const p = path.join(outDir, `latest-softbooks-${sport}.json`);
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          source: "the-odds-api",
          league: sport,
          regions,
          eventCount: events.length,
          books: [...bookSet].sort(),
          events,
        },
        null,
        2,
      ),
    );
    console.log(
      `${sport}: ${events.length} games, ${bookSet.size} books → ${p}`,
    );
    // be gentle on the API
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`Odds API quota remaining: ${lastRemaining}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
