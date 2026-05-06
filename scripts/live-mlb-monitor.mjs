/**
 * live-mlb-monitor.mjs
 * One-shot live snapshot: fetches current ESPN game state + Odds API lines
 * and prints a summary. Run on demand by the betting agent when asked.
 *
 * Usage: node scripts/live-mlb-monitor.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROCESSED = path.join(ROOT, "data", "processed");
const ODDS_API_KEY = "9ebc5915963265268fe8af563a884bf9";

function americanToProb(price) {
  if (price == null) return null;
  if (price > 0) return 100 / (price + 100);
  return Math.abs(price) / (Math.abs(price) + 100);
}

function noVig(p1, p2) {
  if (p1 == null || p2 == null) return [null, null];
  const sum = p1 + p2;
  return [p1 / sum, p2 / sum];
}

async function fetchLiveGames() {
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?limit=50",
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events ?? []).filter((e) => e.status?.type?.state === "in");
  } catch {
    return [];
  }
}

async function fetchCurrentOdds() {
  try {
    const url = new URL("https://api.the-odds-api.com/v4/sports/baseball_mlb/odds");
    url.searchParams.set("apiKey", ODDS_API_KEY);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", "h2h,totals");
    url.searchParams.set("oddsFormat", "american");
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const now = Date.now();
    return data.filter((e) => new Date(e.commence_time).getTime() <= now + 300_000);
  } catch {
    return [];
  }
}

function parseGameState(event) {
  const comp = event.competitions?.[0];
  const status = event.status ?? {};
  const situation = comp?.situation ?? {};
  const home = comp?.competitors?.find((c) => c.homeAway === "home");
  const away = comp?.competitors?.find((c) => c.homeAway === "away");

  const runners = [
    situation.onFirst ? "1B" : null,
    situation.onSecond ? "2B" : null,
    situation.onThird ? "3B" : null,
  ].filter(Boolean);

  return {
    eventId: event.id,
    homeName: home?.team?.abbreviation ?? "HOME",
    awayName: away?.team?.abbreviation ?? "AWAY",
    homeFullName: home?.team?.displayName ?? "Home",
    awayFullName: away?.team?.displayName ?? "Away",
    homeScore: Number(home?.score ?? 0),
    awayScore: Number(away?.score ?? 0),
    inning: status.period ?? "?",
    inningHalf: situation.isTopInning != null ? (situation.isTopInning ? "Top" : "Bot") : "?",
    outs: situation.outs ?? "?",
    baseState: runners.length ? runners.join(", ") : "bases empty",
    pitcher: situation.pitcher?.athlete?.displayName ?? null,
    batter: situation.batter?.athlete?.displayName ?? null,
  };
}

function extractBestOdds(oddsEvent) {
  const h2h = {};
  const totals = [];
  for (const book of oddsEvent.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      for (const outcome of market.outcomes ?? []) {
        if (market.key === "h2h") {
          const cur = h2h[outcome.name];
          if (cur == null || outcome.price > cur) h2h[outcome.name] = outcome.price;
        }
        if (market.key === "totals" && outcome.point != null) {
          const existing = totals.find((t) => t.side === outcome.name && t.point === outcome.point);
          if (!existing) totals.push({ side: outcome.name, point: outcome.point, price: outcome.price });
          else if (outcome.price > existing.price) existing.price = outcome.price;
        }
      }
    }
  }
  return { h2h, totals };
}

function formatPrice(price) {
  if (price == null) return "n/a";
  return price > 0 ? `+${price}` : `${price}`;
}

async function main() {
  const [liveGames, oddsAll] = await Promise.all([fetchLiveGames(), fetchCurrentOdds()]);

  if (!liveGames.length) {
    console.log(JSON.stringify({ status: "no_games", message: "No MLB games currently in progress.", games: [] }));
    return;
  }

  const output = [];

  for (const event of liveGames) {
    const gs = parseGameState(event);

    const oddsEvent = oddsAll.find((o) => {
      const h = (o.home_team ?? "").toLowerCase();
      const a = (o.away_team ?? "").toLowerCase();
      return (
        h.includes(gs.homeName.toLowerCase()) ||
        a.includes(gs.awayName.toLowerCase()) ||
        gs.homeFullName.toLowerCase().includes(h.split(" ").pop() ?? "") ||
        gs.awayFullName.toLowerCase().includes(a.split(" ").pop() ?? "")
      );
    });

    const odds = oddsEvent ? extractBestOdds(oddsEvent) : null;

    // No-vig implied probs from live moneyline
    let homeImplied = null, awayImplied = null;
    if (odds?.h2h) {
      const homeRaw = americanToProb(odds.h2h[gs.homeFullName] ?? odds.h2h[gs.homeName]);
      const awayRaw = americanToProb(odds.h2h[gs.awayFullName] ?? odds.h2h[gs.awayName]);
      [homeImplied, awayImplied] = noVig(homeRaw, awayRaw);
    }

    const game = {
      matchup: `${gs.awayName} @ ${gs.homeName}`,
      score: `${gs.awayScore}-${gs.homeScore}`,
      situation: `${gs.inningHalf} ${gs.inning} | ${gs.outs} out | ${gs.baseState}`,
      pitcher: gs.pitcher,
      batter: gs.batter,
      liveLines: odds
        ? {
            [gs.awayFullName]: {
              ml: formatPrice(odds.h2h[gs.awayFullName] ?? odds.h2h[gs.awayName]),
              impliedWinPct: awayImplied != null ? `${(awayImplied * 100).toFixed(1)}%` : null,
            },
            [gs.homeFullName]: {
              ml: formatPrice(odds.h2h[gs.homeFullName] ?? odds.h2h[gs.homeName]),
              impliedWinPct: homeImplied != null ? `${(homeImplied * 100).toFixed(1)}%` : null,
            },
            totals: odds.totals.map((t) => `${t.side} ${t.point} ${formatPrice(t.price)}`),
          }
        : null,
      oddsAvailable: odds != null,
    };

    output.push(game);
  }

  console.log(JSON.stringify({ status: "ok", fetchedAt: new Date().toISOString(), games: output }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "error", message: err.message }));
  process.exit(1);
});
