/**
 * ingest-soft-props.ts — soft-book player-prop prices from The Odds API,
 * for the props +EV board.
 *
 *   npm run ingest:soft-props
 *
 * QUOTA AWARE: props are per-event calls costing (markets × regions) credits
 * each. Total run cost = markets × regions × events. To keep that inside the
 * free tier (500/mo, shared with ingest:odds + ingest:softbooks) the number of
 * events is derived from a credit budget: events = floor(PROPS_CREDIT_BUDGET /
 * markets), so adding markets trims event coverage instead of multiplying spend.
 * PROPS_MAX_EVENTS (if set) is an additional hard ceiling on events.
 *
 * Default markets cover the sharp side's three biggest buckets — TotalBases,
 * HomeRuns, Strikeouts — which are ~83% of the de-vigged Pinnacle props. Only
 * markets present in PROP_TYPE_MAP can ever match a sharp prop, so requesting
 * batter_hits / batter_rbis (no Pinnacle counterpart on this feed) would just
 * burn credits. Writes data/processed/latest-soft-props-{sport}.json.
 */
import fs from "node:fs";
import path from "node:path";
import type { SoftPropQuote } from "@/lib/props-board";

// Minimal env loader so the CLI runner (tsx) gets the key without Next's env.
for (const envFile of [".env", ".env.local"]) {
  try {
    const envPath = path.resolve(process.cwd(), envFile);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* ignore */
  }
}

const OUT_DIR = path.join(process.cwd(), "data", "processed");
const REGION = "us";
// Credit budget is PER SPORT (1 credit per market per event, 1 region):
// events = floor(budget / markets). Adding markets within a sport trims its
// event coverage instead of multiplying spend; each sport carries its own
// budget so adding a sport is a bounded, opt-in spend increase. PROPS_MAX_EVENTS,
// if set, is an extra hard ceiling on events for every sport.
const MLB_CREDIT_BUDGET = Math.max(1, Number(process.env.PROPS_CREDIT_BUDGET ?? 18));
// WNBA is the smaller in-season slate — give it a smaller default budget so the
// combined props draw stays inside the shared Odds API free tier. 3 markets →
// 3 events ≈ 45 credits/wk-month on top of MLB's ~90.
const WNBA_CREDIT_BUDGET = Math.max(1, Number(process.env.PROPS_WNBA_CREDIT_BUDGET ?? 9));
const EVENT_CEILING = process.env.PROPS_MAX_EVENTS
  ? Math.max(1, Number(process.env.PROPS_MAX_EVENTS))
  : Infinity;

// Default to the three highest-volume sharp-matching markets per sport. Every
// market MUST be a key of PROP_TYPE_MAP or it can never join a sharp prop.
//   MLB: TotalBases, HomeRuns, Strikeouts (~83% of the de-vigged Pinnacle props)
//   WNBA: Points, Rebounds, Assists (Pinnacle posts no Threes props → omitted)
const MLB_DEFAULT_MARKETS = "batter_total_bases,batter_home_runs,pitcher_strikeouts";
const WNBA_DEFAULT_MARKETS = "player_points,player_rebounds,player_assists";

const SPORTS = [
  {
    sport: "mlb",
    key: "baseball_mlb",
    markets: process.env.PROPS_MARKETS ?? MLB_DEFAULT_MARKETS,
    budget: MLB_CREDIT_BUDGET,
  },
  {
    sport: "wnba",
    key: "basketball_wnba",
    markets: process.env.PROPS_WNBA_MARKETS ?? WNBA_DEFAULT_MARKETS,
    budget: WNBA_CREDIT_BUDGET,
  },
];

async function main() {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.warn("[soft-props] THE_ODDS_API_KEY unset — skipping");
    return;
  }
  for (const { sport, key, markets, budget } of SPORTS) {
    try {
      // The /events list is quota-free; only the per-event odds calls cost.
      const evRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${key}/events?apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!evRes.ok) throw new Error(`events HTTP ${evRes.status}`);
      const events: any[] = await evRes.json();
      const now = Date.now();
      // Cost is markets × events (1 region). Spend the credit budget on as many
      // events as it buys, capped by the optional hard event ceiling.
      const marketCount = Math.max(1, markets.split(",").filter(Boolean).length);
      const maxEvents = Math.max(
        1,
        Math.min(Math.floor(budget / marketCount), EVENT_CEILING),
      );
      const upcoming = events
        .filter((e) => {
          const t = Date.parse(e.commence_time);
          return Number.isFinite(t) && t > now && t < now + 12 * 60 * 60 * 1000;
        })
        .slice(0, maxEvents);
      console.log(
        `[soft-props] ${sport}: ${marketCount} markets × ${upcoming.length} events ≈ ${marketCount * upcoming.length} credits`,
      );

      const quotes: SoftPropQuote[] = [];
      for (const ev of upcoming) {
        const oddsRes = await fetch(
          `https://api.the-odds-api.com/v4/sports/${key}/events/${ev.id}/odds` +
            `?apiKey=${apiKey}&regions=${REGION}&markets=${markets}&oddsFormat=american`,
          { signal: AbortSignal.timeout(20_000) },
        );
        if (!oddsRes.ok) {
          console.warn(`[soft-props] event ${ev.id} HTTP ${oddsRes.status} — skipping`);
          continue;
        }
        const data: any = await oddsRes.json();
        // Game identity from the /events row — the parlay book requires it to
        // prove legs come from distinct, independent games. Without an id a
        // leg is ineligible for parlays (still fine for the single-leg board).
        const gameId = ev.id ? String(ev.id) : "";
        const homeTeam = ev.home_team ? String(ev.home_team) : undefined;
        const awayTeam = ev.away_team ? String(ev.away_team) : undefined;
        if (!gameId) {
          console.warn(`[soft-props] event missing id — props on this game are parlay-ineligible`);
        }
        for (const bm of data.bookmakers ?? []) {
          for (const mkt of bm.markets ?? []) {
            for (const o of mkt.outcomes ?? []) {
              if (o.name !== "Over" && o.name !== "Under") continue;
              if (o.point == null || o.price == null || !o.description) continue;
              quotes.push({
                player: String(o.description),
                market: String(mkt.key),
                line: Number(o.point),
                side: o.name,
                american: Number(o.price),
                book: String(bm.key),
                commence: String(ev.commence_time),
                gameId,
                // The Odds API props feed doesn't tag a prop with the player's
                // own side; we record both teams so the correlation rule (same
                // game / same matchup) can fire. Per-side resolution can be
                // refined later via a roster map — both teams suffice for the
                // distinct-game and same-game-stack checks.
                team: homeTeam,
                opponent: awayTeam,
              });
            }
          }
        }
      }

      if (quotes.length === 0) {
        console.log(`[soft-props] ${sport}: 0 quotes (no slate in window?) — leaving existing file`);
        continue;
      }
      const file = path.join(OUT_DIR, `latest-soft-props-${sport}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ fetchedAt: new Date().toISOString(), markets, quotes }, null, 1),
      );
      console.log(
        `[soft-props] ${sport}: ${quotes.length} quotes from ${upcoming.length} events (${markets})`,
      );
    } catch (err) {
      console.warn(`[soft-props] ${sport} failed (non-fatal): ${(err as Error).message}`);
    }
  }
}

main();
