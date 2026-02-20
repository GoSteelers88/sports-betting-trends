import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildFreeStatsSummary, type FreeStatLike, type InjuryEntry } from "@/lib/free-stats-summary";
import type { StandingsEntry } from "@/lib/advanced-metrics";

type PlayerPropSummary = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
};

type SummaryShape = {
  leagues?: Array<{ league?: string }>;
  latestByLeague?: Array<{ league?: string; conference?: string | null }>;
  bestBets?: Array<{ league?: string; conference?: string | null }>;
  conferences?: string[];
  playerProps?: PlayerPropSummary[];
  playerPropsNote?: string | null;
  playerPropsGeneratedAt?: string | null;
  [key: string]: unknown;
};

async function readProcessedFallback() {
  const fallbackPath = path.join(process.cwd(), "data", "processed", "latest-summary.json");
  const raw = await readFile(fallbackPath, "utf-8");
  const parsed = JSON.parse(raw) as SummaryShape;
  const props = await loadPlayerPropsSummary();
  return {
    ...parsed,
    ...props,
    source: "processed-fallback",
  };
}

async function loadJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function loadPlayerPropsSummary() {
  const propsPath = path.join(process.cwd(), "data", "processed", "latest-player-props.json");
  const parsed = await loadJsonFile<{
    generatedAt?: string;
    note?: string | null;
    topProps?: PlayerPropSummary[];
    available?: boolean;
  }>(propsPath);

  if (!parsed) {
    return {
      playerProps: [] as PlayerPropSummary[],
      playerPropsNote: "Player props file not found. Run npm run ingest:props.",
      playerPropsGeneratedAt: null,
    };
  }

  const note = parsed.note ?? (parsed.available === false ? "Player props unavailable for current API access." : null);

  return {
    playerProps: parsed.topProps ?? [],
    playerPropsNote: note,
    playerPropsGeneratedAt: parsed.generatedAt ?? null,
  };
}

function applyFiltersToSummary(summary: SummaryShape, league?: string, conference?: string) {
  const leagueMatch = (value?: string | null) => !league || value === league;
  const conferenceMatch = (value?: string | null) => !conference || value === conference;

  const leagues = (summary.leagues ?? []).filter((l) => leagueMatch(l.league));
  const latestByLeague = (summary.latestByLeague ?? []).filter(
    (item) => leagueMatch(item.league) && conferenceMatch(item.conference),
  );
  const bestBets = (summary.bestBets ?? []).filter(
    (item) => leagueMatch(item.league) && conferenceMatch(item.conference),
  );

  const conferencesFromData = new Set<string>();
  latestByLeague.forEach((item) => {
    if (item.conference) conferencesFromData.add(item.conference);
  });
  bestBets.forEach((item) => {
    if (item.conference) conferencesFromData.add(item.conference);
  });

  const conferences = [...conferencesFromData].sort();

  return {
    ...summary,
    leagues,
    latestByLeague,
    bestBets,
    conferences,
    filtersApplied: {
      league: league ?? "ALL",
      conference: conference ?? "ALL",
    },
  };
}

function parseLeague(value: string | null) {
  if (!value || value === "ALL") return undefined;
  return value.toUpperCase();
}

function parseConference(value: string | null) {
  if (!value || value === "ALL") return undefined;
  return value;
}

export async function GET(req: NextRequest) {
  const league = parseLeague(req.nextUrl.searchParams.get("league"));
  const conference = parseConference(req.nextUrl.searchParams.get("conference"));

  try {
    const all = await prisma.freeStat.findMany({
      where: {
        ...(league ? { league } : {}),
        ...(conference ? { conference } : {}),
      },
      orderBy: [{ gameDate: "desc" }],
      select: {
        league: true,
        conference: true,
        gameDate: true,
        team: true,
        opponent: true,
        points: true,
        opponentPoints: true,
        rebounds: true,
        assists: true,
        yards: true,
        spread: true,
        atsResult: true,
        won: true,
        teamRank: true,
        opponentRank: true,
        bubbleStatus: true,
        autoBidStatus: true,
        source: true,
        sourceEventId: true,
        gameStatus: true,
        completionEvidence: true,
        // New box score fields
        fgm: true,
        fga: true,
        threepm: true,
        threepa: true,
        ftm: true,
        fta: true,
        offRebounds: true,
        defRebounds: true,
        steals: true,
        blocks: true,
        turnovers: true,
        passingYards: true,
        rushingYards: true,
        opponentYards: true,
        turnoversFor: true,
        turnoversAgainst: true,
        thirdDownConv: true,
        thirdDownAtt: true,
        redZoneConv: true,
        redZoneAtt: true,
        timeOfPossession: true,
        homeAway: true,
        hits: true,
        errors: true,
      },
    });

    if (all.length === 0) {
      const fallback = await readProcessedFallback();
      return NextResponse.json(applyFiltersToSummary(fallback, league, conference));
    }

    const rows: FreeStatLike[] = all.map((r) => ({ ...r }));

    // Load odds
    const oddsPath = path.join(process.cwd(), "data", "processed", "latest-odds-api.json");
    let oddsEvents: unknown[] = [];
    try {
      const oddsRaw = await readFile(oddsPath, "utf-8");
      const parsed = JSON.parse(oddsRaw) as { events?: unknown[] };
      oddsEvents = parsed.events ?? [];
    } catch {
      oddsEvents = [];
    }

    // Load standings
    const processedDir = path.join(process.cwd(), "data", "processed");
    const standingsMap: Record<string, StandingsEntry[]> = {};
    for (const key of ["nba", "nfl", "mlb", "ncaab"]) {
      const data = await loadJsonFile<StandingsEntry[]>(path.join(processedDir, `standings-${key}.json`));
      if (data) standingsMap[key] = data;
    }

    // Load injuries
    const injuriesMap: Record<string, InjuryEntry[]> = {};
    for (const key of ["nba", "nfl"]) {
      const data = await loadJsonFile<InjuryEntry[]>(path.join(processedDir, `injuries-${key}.json`));
      if (data) injuriesMap[key] = data;
    }

    const todayEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const nbaOddsToday = (oddsEvents as Array<Record<string, unknown>>).filter(e => {
      if (!e.home_team || !e.away_team || !e.commence_time) return false;
      if (e.sport_key !== "basketball_nba") return false;
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(e.commence_time as string)) === todayEt;
    });

    const summary = buildFreeStatsSummary(rows, {
      oddsEvents: oddsEvents as never[],
      standings: standingsMap,
      injuries: injuriesMap,
    });

    const playerPropsPayload = await loadPlayerPropsSummary();

    const conferenceUniverse = await prisma.freeStat.findMany({
      where: {
        conference: { not: null },
        ...(league ? { league } : {}),
      },
      distinct: ["conference"],
      select: { conference: true },
      orderBy: { conference: "asc" },
    });

    return NextResponse.json({
      ...summary,
      ...playerPropsPayload,
      conferences: conferenceUniverse.map((c) => c.conference).filter(Boolean),
      filtersApplied: {
        league: league ?? "ALL",
        conference: conference ?? "ALL",
      },
      source: "prisma",
      _debug: { oddsEventCount: oddsEvents.length, nbaOddsTodayCount: nbaOddsToday.length, todayEt, bestBetsCount: summary.bestBets.length },
    });
  } catch {
    const fallback = await readProcessedFallback();
    return NextResponse.json(applyFiltersToSummary(fallback, league, conference));
  }
}
