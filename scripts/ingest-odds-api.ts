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

async function main() {
  const root = process.cwd();
  loadEnvConfig(root);

  const apiKey = getRequiredEnv("THE_ODDS_API_KEY");
  const league = getOptionalEnv("THE_ODDS_LEAGUE", "basketball_ncaab")!;
  const regions = getOptionalEnv("THE_ODDS_REGIONS", "us")!;
  const markets = getOptionalEnv("THE_ODDS_MARKETS", "h2h,spreads")!;
  const oddsFormat = getOptionalEnv("THE_ODDS_ODDS_FORMAT", "american")!;

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
    throw new Error(`The Odds API request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as OddsEvent[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`The Odds API returned an empty payload for league '${league}'.`);
  }

  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "latest-odds-api.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        league,
        regions,
        markets,
        eventCount: data.length,
        sampleEvent: {
          id: data[0]?.id,
          sport_key: data[0]?.sport_key,
          commence_time: data[0]?.commence_time,
          home_team: data[0]?.home_team,
          away_team: data[0]?.away_team,
        },
        events: data,
      },
      null,
      2,
    ),
  );

  const remaining = res.headers.get("x-requests-remaining") ?? "unknown";
  const used = res.headers.get("x-requests-used") ?? "unknown";

  console.log(`The Odds API pull succeeded: ${data.length} events for ${league}.`);
  console.log(`Quota headers: remaining=${remaining}, used=${used}`);
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
