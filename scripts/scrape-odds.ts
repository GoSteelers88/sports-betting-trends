/**
 * Scrape odds from FanDuel + Bovada (public JSON endpoints).
 *
 * Replaces the paid Odds API ingest. Emits files matching the existing
 * OddsEvent shape so all downstream code (agent tools, dashboard,
 * mlb-model, debug-odds route) keeps working.
 *
 * - FanDuel: content-managed-page SPORT endpoint per eventTypeId
 *   (NBA+WNBA=7522, MLB=7511, NHL=7524). Filter NBA vs WNBA by competitionId.
 * - Bovada: coupon/events endpoint per league path. Second book gives the
 *   `bookSpread` signal the analyst's off-market scan needs.
 */
import fs from "node:fs";
import path from "node:path";
import { mlbSlateEvents } from "@/lib/injuries-scope";

type Outcome = { name: string; price: number; point?: number };
type Market = { key: "h2h" | "spreads" | "totals"; outcomes: Outcome[] };
type Bookmaker = { key: string; title: string; markets: Market[] };
type OddsEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Bookmaker[];
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type LeagueSpec = {
  sportKey: string;
  sportTitle: string;
  fd?: { eventTypeId: number; competitionId?: number };
  bovada?: { path: string };
};

const LEAGUES: LeagueSpec[] = [
  {
    sportKey: "basketball_nba",
    sportTitle: "NBA",
    fd: { eventTypeId: 7522, competitionId: 10547864 },
    bovada: { path: "basketball/nba" },
  },
  {
    sportKey: "basketball_wnba",
    sportTitle: "WNBA",
    fd: { eventTypeId: 7522, competitionId: 11295025 },
    bovada: { path: "basketball/wnba" },
  },
  {
    sportKey: "baseball_mlb",
    sportTitle: "MLB",
    fd: { eventTypeId: 7511 },
    bovada: { path: "baseball/mlb" },
  },
  {
    sportKey: "icehockey_nhl",
    sportTitle: "NHL",
    fd: { eventTypeId: 7524 },
    bovada: { path: "hockey/nhl" },
  },
];

// ───────────────────────────────────────────────────────────────────────────
// FanDuel
// ───────────────────────────────────────────────────────────────────────────

type FdRunner = {
  runnerName: string;
  handicap: number;
  winRunnerOdds?: { americanDisplayOdds?: { americanOdds?: number } };
};
type FdMarket = {
  marketId: string;
  marketType: string;
  eventId: number;
  competitionId?: number;
  runners: FdRunner[];
};
type FdEvent = {
  eventId: number;
  name: string;
  openDate: string;
  competitionId?: number;
};

async function fetchFanDuel(spec: LeagueSpec): Promise<OddsEvent[]> {
  if (!spec.fd) return [];
  const url = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=SPORT&eventTypeId=${spec.fd.eventTypeId}&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.warn(`FanDuel ${spec.sportKey}: HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    attachments?: {
      events?: Record<string, FdEvent>;
      markets?: Record<string, FdMarket>;
    };
  };
  const events = Object.values(data.attachments?.events ?? {});
  const markets = Object.values(data.attachments?.markets ?? {});

  // Filter to game events (name has @ or vs) and matching competition.
  const games = events.filter((e) => {
    if (!e.openDate || !e.name) return false;
    if (!/[@]|\svs\.?\s/i.test(e.name)) return false;
    if (spec.fd?.competitionId && e.competitionId !== spec.fd.competitionId) {
      return false;
    }
    return true;
  });

  return games
    .map((ev) => buildEventFromFd(ev, markets, spec))
    .filter((e): e is OddsEvent => e !== null);
}

function buildEventFromFd(
  ev: FdEvent,
  markets: FdMarket[],
  spec: LeagueSpec,
): OddsEvent | null {
  // FanDuel name format: "Away @ Home" (verified) — sometimes "Home vs Away".
  const { away, home } = parseFdName(ev.name);
  if (!away || !home) return null;

  const evMarkets = markets.filter((m) => m.eventId === ev.eventId);
  const outMarkets: Market[] = [];

  // Moneyline
  const ml = evMarkets.find((m) => m.marketType === "MONEY_LINE");
  if (ml) {
    const outcomes = ml.runners
      .map((r) => ({
        name: r.runnerName,
        price: r.winRunnerOdds?.americanDisplayOdds?.americanOdds,
      }))
      .filter((o): o is Outcome => typeof o.price === "number");
    if (outcomes.length === 2) outMarkets.push({ key: "h2h", outcomes });
  }

  // Spreads (handicap)
  const sp = evMarkets.find((m) => m.marketType === "MATCH_HANDICAP_(2-WAY)");
  if (sp) {
    const outcomes = sp.runners
      .map((r) => ({
        name: r.runnerName,
        price: r.winRunnerOdds?.americanDisplayOdds?.americanOdds,
        point: r.handicap,
      }))
      .filter((o): o is Outcome => typeof o.price === "number");
    if (outcomes.length === 2) outMarkets.push({ key: "spreads", outcomes });
  }

  // Totals
  const tot = evMarkets.find(
    (m) => m.marketType === "TOTAL_POINTS_(OVER/UNDER)",
  );
  if (tot) {
    const outcomes = tot.runners
      .map((r) => ({
        name: r.runnerName, // "Over" / "Under"
        price: r.winRunnerOdds?.americanDisplayOdds?.americanOdds,
        point: r.handicap,
      }))
      .filter((o): o is Outcome => typeof o.price === "number");
    if (outcomes.length === 2) outMarkets.push({ key: "totals", outcomes });
  }

  if (outMarkets.length === 0) return null;

  return {
    id: `fd_${ev.eventId}`,
    sport_key: spec.sportKey,
    sport_title: spec.sportTitle,
    commence_time: ev.openDate,
    home_team: home,
    away_team: away,
    bookmakers: [{ key: "fanduel", title: "FanDuel", markets: outMarkets }],
  };
}

function parseFdName(name: string): { away: string; home: string } {
  // FanDuel MLB names include the starting pitcher: "Yankees (R Weathers) @ Orioles (B Young)".
  // Strip parenthetical suffix from each side so the team string matches other books.
  const strip = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  let m = name.match(/^(.+?)\s+@\s+(.+)$/);
  if (m) return { away: strip(m[1]), home: strip(m[2]) };
  m = name.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (m) return { away: strip(m[2]), home: strip(m[1]) };
  return { away: "", home: "" };
}

// ───────────────────────────────────────────────────────────────────────────
// Bovada
// ───────────────────────────────────────────────────────────────────────────

type BvOutcome = {
  description: string;
  price?: { american?: string; handicap?: string };
};
type BvMarket = {
  description: string;
  key: string;
  outcomes: BvOutcome[];
  period?: { description?: string; main?: boolean };
};
type BvDisplayGroup = { description: string; markets: BvMarket[] };
type BvCompetitor = { name: string; home: boolean };
type BvEvent = {
  id: string;
  description: string;
  startTime: number;
  competitors: BvCompetitor[];
  displayGroups: BvDisplayGroup[];
};

async function fetchBovada(spec: LeagueSpec): Promise<OddsEvent[]> {
  if (!spec.bovada) return [];
  const url = `https://www.bovada.lv/services/sports/event/coupon/events/A/description/${spec.bovada.path}?marketFilterId=def&preMatchOnly=true&lang=en`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.warn(`Bovada ${spec.sportKey}: HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as Array<{ events?: BvEvent[] }>;
  const events: BvEvent[] = [];
  for (const group of data) for (const ev of group.events ?? []) events.push(ev);

  return events
    .map((ev) => buildEventFromBovada(ev, spec))
    .filter((e): e is OddsEvent => e !== null);
}

function buildEventFromBovada(
  ev: BvEvent,
  spec: LeagueSpec,
): OddsEvent | null {
  const home = ev.competitors?.find((c) => c.home)?.name ?? "";
  const away = ev.competitors?.find((c) => !c.home)?.name ?? "";
  if (!home || !away) return null;

  const outMarkets: Market[] = [];
  for (const group of ev.displayGroups ?? []) {
    if (!/game lines/i.test(group.description)) continue;
    for (const m of group.markets ?? []) {
      // Bovada includes 1st quarter / 1st half markets in Game Lines — filter
      // to the main full-game market by period.main when available, else by
      // period.description being empty or "Match"/"Game".
      const period = m.period?.description ?? "";
      const isMain = m.period?.main === true || /match|game|^$/i.test(period);
      if (!isMain) continue;

      if (m.key === "2W-HCAP") {
        const outcomes = m.outcomes
          .map((o) => ({
            name: o.description,
            price: parseAmerican(o.price?.american),
            point: parseFloat(o.price?.handicap ?? "NaN"),
          }))
          .filter(
            (o): o is Outcome =>
              typeof o.price === "number" &&
              typeof o.point === "number" &&
              !Number.isNaN(o.point),
          );
        if (outcomes.length === 2) outMarkets.push({ key: "spreads", outcomes });
      } else if (m.key === "2W-12") {
        // Moneyline (2-way, 1/2 outcomes — pick 'em or moneyline).
        const outcomes = m.outcomes
          .map((o) => ({
            name: o.description,
            price: parseAmerican(o.price?.american),
          }))
          .filter((o): o is Outcome => typeof o.price === "number");
        if (outcomes.length === 2) outMarkets.push({ key: "h2h", outcomes });
      } else if (m.key === "2W-OU") {
        const outcomes = m.outcomes
          .map((o) => ({
            name: o.description,
            price: parseAmerican(o.price?.american),
            point: parseFloat(o.price?.handicap ?? "NaN"),
          }))
          .filter(
            (o): o is Outcome =>
              typeof o.price === "number" &&
              typeof o.point === "number" &&
              !Number.isNaN(o.point),
          );
        if (outcomes.length === 2) outMarkets.push({ key: "totals", outcomes });
      }
    }
  }

  if (outMarkets.length === 0) return null;

  return {
    id: `bv_${ev.id}`,
    sport_key: spec.sportKey,
    sport_title: spec.sportTitle,
    commence_time: new Date(ev.startTime).toISOString(),
    home_team: home,
    away_team: away,
    bookmakers: [{ key: "bovada", title: "Bovada", markets: outMarkets }],
  };
}

function parseAmerican(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/^EVEN$/i, "100").replace(/[^\d+\-]/g, "");
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Merge books by team + same-day commence_time
// ───────────────────────────────────────────────────────────────────────────

function normalizeTeam(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .replace(/^the\s+/, "")
    .trim();
}

function mergeBooks(...sources: OddsEvent[][]): OddsEvent[] {
  const byKey = new Map<string, OddsEvent>();
  for (const source of sources) {
    for (const ev of source) {
      const dateKey = ev.commence_time.slice(0, 10);
      const pair = [ev.home_team, ev.away_team]
        .map(normalizeTeam)
        .sort()
        .join("|");
      const key = `${ev.sport_key}|${dateKey}|${pair}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.bookmakers.push(...ev.bookmakers);
      } else {
        byKey.set(key, { ...ev, bookmakers: [...ev.bookmakers] });
      }
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.commence_time.localeCompare(b.commence_time),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

async function main() {
  const outDir = path.join(process.cwd(), "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  const all: OddsEvent[] = [];

  for (const spec of LEAGUES) {
    const [fd, bv] = await Promise.all([
      fetchFanDuel(spec).catch((e) => {
        console.warn(`FD ${spec.sportKey} threw:`, (e as Error).message);
        return [] as OddsEvent[];
      }),
      fetchBovada(spec).catch((e) => {
        console.warn(`BV ${spec.sportKey} threw:`, (e as Error).message);
        return [] as OddsEvent[];
      }),
    ]);

    const merged = mergeBooks(fd, bv);
    const bookCounts = countBooks(merged);
    console.log(
      `${spec.sportKey}: FD=${fd.length} BV=${bv.length} → ${merged.length} merged (books: ${bookCounts})`,
    );

    // The baseball_mlb endpoint returns NPB/KBO/CPBL/NCAA games alongside real
    // MLB. Scope the on-disk file to the 30 MLB franchises for ALL downstream
    // consumers (agent get_odds, MarketFeed slate, injuries scoping, prop
    // board). Only baseball_mlb — never the other sports.
    // Guard (same spirit as the "0 events" guard): if filtering would empty an
    // otherwise non-empty feed (allowlist bug on a real game day), keep the
    // unfiltered set rather than writing an empty file.
    let toWrite = merged;
    if (spec.sportKey === "baseball_mlb" && merged.length > 0) {
      const mlbOnly = mlbSlateEvents(merged);
      if (mlbOnly.length > 0) {
        const dropped = merged.length - mlbOnly.length;
        if (dropped > 0) {
          console.log(
            `  baseball_mlb: filtered ${dropped} non-MLB (NPB/KBO/CPBL/NCAA) → ${mlbOnly.length} MLB games`,
          );
        }
        toWrite = mlbOnly;
      } else {
        console.warn(
          `baseball_mlb: MLB filter would empty a ${merged.length}-event feed — keeping unfiltered set (allowlist bug?)`,
        );
      }
    }

    if (toWrite.length > 0) {
      writeLeagueFile(outDir, spec.sportKey, toWrite);
    } else {
      console.warn(`${spec.sportKey}: 0 events — leaving existing file in place`);
    }
    all.push(...toWrite);
  }

  if (all.length > 0) {
    writeCombinedFile(outDir, all);
  }
  console.log(
    `\nTotal: ${all.length} events across ${LEAGUES.length} leagues`,
  );
}

function countBooks(events: OddsEvent[]): string {
  const counts: Record<string, number> = {};
  for (const ev of events) {
    for (const b of ev.bookmakers) {
      counts[b.key] = (counts[b.key] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

function writeLeagueFile(outDir: string, sportKey: string, events: OddsEvent[]) {
  const p = path.join(outDir, `latest-odds-api-${sportKey}.json`);
  const payload = {
    fetchedAt: new Date().toISOString(),
    league: sportKey,
    regions: "us",
    markets: "h2h,spreads,totals",
    eventCount: events.length,
    sampleEvent: events[0]
      ? {
          id: events[0].id,
          sport_key: events[0].sport_key,
          commence_time: events[0].commence_time,
          home_team: events[0].home_team,
          away_team: events[0].away_team,
        }
      : null,
    events,
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  console.log(`  → ${p}`);
}

function writeCombinedFile(outDir: string, events: OddsEvent[]) {
  const p = path.join(outDir, "latest-odds-api.json");
  const payload = {
    fetchedAt: new Date().toISOString(),
    leagues: LEAGUES.map((l) => l.sportKey).join(","),
    regions: "us",
    markets: "h2h,spreads,totals",
    eventCount: events.length,
    sampleEvent: events[0]
      ? {
          id: events[0].id,
          sport_key: events[0].sport_key,
          commence_time: events[0].commence_time,
          home_team: events[0].home_team,
          away_team: events[0].away_team,
        }
      : null,
    events,
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  console.log(`  → ${p}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
