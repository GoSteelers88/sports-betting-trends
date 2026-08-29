/**
 * Scrape SHARP reference lines from Pinnacle's public guest API.
 *
 * Pinnacle is the sharpest mainstream book — low, symmetric vig and the line
 * the rest of the market moves toward. Its de-vigged price is the fair value
 * we measure every soft-book offer against (see src/lib/fair-value.ts). This
 * is the feed that unlocks the de-vigged-sharp pivot; without it there is no
 * sharp anchor and "edge" is just the model arguing with the vig.
 *
 * Endpoints (unauthenticated guest API, public key embedded in pinnacle.com):
 *   GET /0.1/leagues/{leagueId}/matchups          → games + participants
 *   GET /0.1/leagues/{leagueId}/markets/straight   → prices keyed by matchupId
 *
 * Output: data/processed/latest-sharp-pinnacle-{sportKey}.json
 *   { fetchedAt, league, source:"pinnacle", eventCount, events: [...] }
 * where each event carries de-vig-ready full-game moneyline (priority) plus
 * the main total and main spread.
 *
 * NBA = leagueId 487, MLB = leagueId 246 (default: the clv-proof cron pair).
 * NFL = leagueId 889, NCAAF = leagueId 880 — opt-in via --leagues, used by the
 * /nfl receipts close-capture and the CFB shadow book (verified live 2026-08-19:
 * HTTP 200, 16 week-1 NFL matchups).
 *
 * Flags (added 2026-08-29 for the receipts pipeline; default behavior for the
 * existing clv-proof cron is unchanged):
 *   --leagues nba,mlb,nfl,ncaaf   subset to scrape (default nba,mlb)
 *   --strict                      any league that returns null, or fewer than
 *                                 its strict minimum of matchups, exits 1.
 *                                 The Pinnacle guest API is undocumented and
 *                                 getJson() returns null on error — once a
 *                                 feed is load-bearing (threat T15), silence
 *                                 must be a hard failure, not an omission.
 *   --archive <dir>               additionally write a DATED, committed copy
 *                                 (the latest-* path is gitignored; captured
 *                                 closes must survive in git — threat T16)
 */
import fs from "node:fs";
import path from "node:path";

// Public guest key shipped in Pinnacle's own web client. Override via env if
// they ever rotate it.
const PINNACLE_API_KEY =
  process.env.PINNACLE_API_KEY ?? "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";
const BASE = "https://guest.api.arcadia.pinnacle.com/0.1";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type LeagueSpec = {
  sportKey: string;
  sportTitle: string;
  leagueId: number;
  /** --strict floor: an in-season feed below this count is a broken scrape,
   *  not a quiet week (NFL slates run 13–16 games and the matchups endpoint
   *  lists upcoming weeks, so 14 is conservative — threat T15). */
  strictMinMatchups: number;
};

const ALL_LEAGUES: Record<string, LeagueSpec> = {
  nba: { sportKey: "basketball_nba", sportTitle: "NBA", leagueId: 487, strictMinMatchups: 4 },
  mlb: { sportKey: "baseball_mlb", sportTitle: "MLB", leagueId: 246, strictMinMatchups: 6 },
  nfl: { sportKey: "americanfootball_nfl", sportTitle: "NFL", leagueId: 889, strictMinMatchups: 14 },
  ncaaf: { sportKey: "americanfootball_ncaaf", sportTitle: "NCAAF", leagueId: 880, strictMinMatchups: 20 },
};

function parseArgs(): { leagues: LeagueSpec[]; strict: boolean; archiveDir: string | null } {
  const argv = process.argv.slice(2);
  let leagues = [ALL_LEAGUES.nba, ALL_LEAGUES.mlb];
  let strict = false;
  let archiveDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--strict") strict = true;
    else if (argv[i] === "--leagues") {
      const names = (argv[++i] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      leagues = names.map((n) => {
        const spec = ALL_LEAGUES[n];
        if (!spec) throw new Error(`unknown league "${n}" (valid: ${Object.keys(ALL_LEAGUES).join(",")})`);
        return spec;
      });
    } else if (argv[i] === "--archive") {
      archiveDir = argv[++i] ?? null;
      if (!archiveDir) throw new Error("--archive requires a directory");
    }
  }
  const minOverride = Number(process.env.PINNACLE_STRICT_MIN ?? "");
  if (Number.isFinite(minOverride) && minOverride > 0) {
    leagues = leagues.map((l) => ({ ...l, strictMinMatchups: minOverride }));
  }
  return { leagues, strict, archiveDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pinnacle response shapes (only the fields we read)
// ─────────────────────────────────────────────────────────────────────────────

type PinParticipant = {
  id: number;
  name: string;
  alignment?: "home" | "away" | "neutral";
};
type PinMatchup = {
  id: number;
  type: string; // "matchup" for a real game; "special" etc. for props/futures
  startTime?: string;
  isLive?: boolean;
  parentId?: number | null;
  participants?: PinParticipant[];
};
type PinPrice = {
  designation?: "home" | "away" | "over" | "under" | "draw";
  points?: number;
  price: number; // American
};
type PinMarket = {
  matchupId: number;
  key: string; // e.g. "s;0;m", "s;0;ou;8.5", "s;0;s;-1.5"
  period: number; // 0 = full game
  type: "moneyline" | "spread" | "total" | "team_total" | string;
  prices: PinPrice[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Our normalized output shape
// ─────────────────────────────────────────────────────────────────────────────

export type SharpMoneyline = { home: number; away: number };
export type SharpTotal = { point: number; over: number; under: number };
export type SharpSpread = {
  point: number; // home line (e.g. -1.5)
  home: number;
  away: number;
};
export type SharpEvent = {
  id: string; // "pin_<matchupId>"
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  moneyline?: SharpMoneyline;
  total?: SharpTotal;
  spread?: SharpSpread;
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": PINNACLE_API_KEY,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Referer: "https://www.pinnacle.com/",
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      console.warn(`Pinnacle ${url}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`Pinnacle ${url} threw:`, (err as Error).message);
    return null;
  }
}

// Pick the "main" line from a set of alternative lines: the one whose two
// prices are most balanced (closest to a coin flip), which is Pinnacle's
// pivot/primary number. Robust for both totals and spreads.
function balance(a: number, b: number): number {
  // smaller = more balanced; compare absolute American magnitudes
  return Math.abs(Math.abs(a) - Math.abs(b));
}

function buildEvents(
  matchups: PinMatchup[],
  markets: PinMarket[],
  spec: LeagueSpec,
): SharpEvent[] {
  // Index full-game markets by matchupId.
  const byMatchup = new Map<number, PinMarket[]>();
  for (const m of markets) {
    if (m.period !== 0) continue; // full game only
    const list = byMatchup.get(m.matchupId) ?? [];
    list.push(m);
    byMatchup.set(m.matchupId, list);
  }

  const events: SharpEvent[] = [];
  for (const g of matchups) {
    if (g.type !== "matchup") continue; // skip specials / props / futures
    if (g.isLive) continue; // pre-game lines only
    if (g.parentId != null) continue; // skip derivative/related markets
    const parts = g.participants ?? [];
    const home = parts.find((p) => p.alignment === "home")?.name;
    const away = parts.find((p) => p.alignment === "away")?.name;
    if (!home || !away) continue;

    const mks = byMatchup.get(g.id) ?? [];

    // Moneyline (priority) — exactly two designations home/away.
    let moneyline: SharpMoneyline | undefined;
    const mlMarket = mks.find(
      (m) => m.type === "moneyline" && m.key === `s;0;m`,
    );
    if (mlMarket) {
      const h = mlMarket.prices.find((p) => p.designation === "home")?.price;
      const a = mlMarket.prices.find((p) => p.designation === "away")?.price;
      if (typeof h === "number" && typeof a === "number") {
        moneyline = { home: h, away: a };
      }
    }

    // Main total — most balanced over/under among the full-game totals.
    let total: SharpTotal | undefined;
    const totalMarkets = mks.filter((m) => m.type === "total");
    let bestTotalBalance = Infinity;
    for (const m of totalMarkets) {
      const o = m.prices.find((p) => p.designation === "over");
      const u = m.prices.find((p) => p.designation === "under");
      if (!o || !u || typeof o.price !== "number" || typeof u.price !== "number")
        continue;
      const bal = balance(o.price, u.price);
      if (bal < bestTotalBalance) {
        bestTotalBalance = bal;
        total = { point: o.points ?? NaN, over: o.price, under: u.price };
      }
    }

    // Main spread — most balanced home/away among the full-game spreads.
    let spread: SharpSpread | undefined;
    const spreadMarkets = mks.filter((m) => m.type === "spread");
    let bestSpreadBalance = Infinity;
    for (const m of spreadMarkets) {
      const h = m.prices.find((p) => p.designation === "home");
      const a = m.prices.find((p) => p.designation === "away");
      if (!h || !a || typeof h.price !== "number" || typeof a.price !== "number")
        continue;
      const bal = balance(h.price, a.price);
      if (bal < bestSpreadBalance) {
        bestSpreadBalance = bal;
        spread = { point: h.points ?? NaN, home: h.price, away: a.price };
      }
    }

    // A game with none of the three markets is useless — skip it.
    if (!moneyline && !total && !spread) continue;

    events.push({
      id: `pin_${g.id}`,
      sport_key: spec.sportKey,
      sport_title: spec.sportTitle,
      commence_time: g.startTime ?? "",
      home_team: home,
      away_team: away,
      moneyline,
      total,
      spread,
    });
  }

  events.sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  return events;
}

async function scrapeLeague(spec: LeagueSpec): Promise<SharpEvent[]> {
  const [matchups, markets] = await Promise.all([
    getJson<PinMatchup[]>(`${BASE}/leagues/${spec.leagueId}/matchups`),
    getJson<PinMarket[]>(`${BASE}/leagues/${spec.leagueId}/markets/straight`),
  ]);
  if (!matchups || !markets) {
    console.warn(`${spec.sportKey}: missing matchups or markets — skipping`);
    return [];
  }
  return buildEvents(matchups, markets, spec);
}

function writeLeagueFile(outDir: string, spec: LeagueSpec, events: SharpEvent[]) {
  const p = path.join(
    outDir,
    `latest-sharp-pinnacle-${spec.sportKey}.json`,
  );
  const withMl = events.filter((e) => e.moneyline).length;
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: "pinnacle",
    league: spec.sportKey,
    eventCount: events.length,
    moneylineCount: withMl,
    events,
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  console.log(`  → ${p} (${events.length} games, ${withMl} with moneyline)`);
}

function writeArchiveFile(
  archiveDir: string,
  spec: LeagueSpec,
  events: SharpEvent[],
): void {
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const p = path.join(archiveDir, `pinnacle-${spec.sportKey}-${stamp}.json`);
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        source: "pinnacle",
        league: spec.sportKey,
        eventCount: events.length,
        events,
      },
      null,
      2,
    ),
  );
  console.log(`  → archived ${p}`);
}

async function main() {
  const { leagues, strict, archiveDir } = parseArgs();
  const outDir = path.join(process.cwd(), "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  let grandTotal = 0;
  const failures: string[] = [];
  for (const spec of leagues) {
    const events = await scrapeLeague(spec);
    console.log(`${spec.sportKey}: ${events.length} sharp games`);
    if (strict && events.length < spec.strictMinMatchups) {
      failures.push(
        `${spec.sportKey}: ${events.length} < strict minimum ${spec.strictMinMatchups}`,
      );
      continue;
    }
    if (events.length > 0) {
      writeLeagueFile(outDir, spec, events);
      if (archiveDir) writeArchiveFile(archiveDir, spec, events);
      grandTotal += events.length;
    } else {
      console.warn(
        `${spec.sportKey}: 0 events — leaving existing sharp file in place`,
      );
    }
  }
  console.log(`\nTotal: ${grandTotal} sharp games across ${leagues.length} leagues`);
  if (failures.length > 0) {
    // Strict mode exists because a null/thin Pinnacle response is now
    // load-bearing for the receipts ledger — fail LOUD, never omit silently.
    console.error(`STRICT FAILURE:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
