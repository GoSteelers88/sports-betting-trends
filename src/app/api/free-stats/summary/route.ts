export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildFreeStatsSummary, type FreeStatLike, type InjuryEntry } from "@/lib/free-stats-summary";
import type { StandingsEntry } from "@/lib/advanced-metrics";
import latestSummary from "../../../../../data/processed/latest-summary.json";
import latestOdds from "../../../../../data/processed/latest-odds-api.json";
import latestProps from "../../../../../data/processed/latest-player-props.json";
import standingsNba from "../../../../../data/processed/standings-nba.json";
import standingsNfl from "../../../../../data/processed/standings-nfl.json";
import standingsMlb from "../../../../../data/processed/standings-mlb.json";
import standingsNcaab from "../../../../../data/processed/standings-ncaab.json";
import injuriesNba from "../../../../../data/processed/injuries-nba.json";
import injuriesNfl from "../../../../../data/processed/injuries-nfl.json";

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
  const parsed = latestSummary as unknown as SummaryShape;
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
  const parsed = latestProps as unknown as {
    generatedAt?: string;
    note?: string | null;
    topProps?: PlayerPropSummary[];
    available?: boolean;
  };
  const note = parsed.note ?? (parsed.available === false ? "Player props unavailable for current API access." : null);
  return {
    playerProps: (parsed.topProps ?? []) as PlayerPropSummary[],
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
      return NextResponse.json(applyFiltersToSummary(fallback, league, conference), { headers: { "Cache-Control": "no-store" } });
    }

    const rows: FreeStatLike[] = all.map((r) => ({ ...r }));

    // Load odds (imported at build time — always matches committed file)
    const oddsEvents: unknown[] = (latestOdds as unknown as { events?: unknown[] }).events ?? [];

    // Load standings (imported at build time)
    const standingsMap: Record<string, StandingsEntry[]> = {
      nba: standingsNba as unknown as StandingsEntry[],
      nfl: standingsNfl as unknown as StandingsEntry[],
      mlb: standingsMlb as unknown as StandingsEntry[],
      ncaab: standingsNcaab as unknown as StandingsEntry[],
    };

    // Load injuries (imported at build time)
    const injuriesMap: Record<string, InjuryEntry[]> = {
      nba: injuriesNba as unknown as InjuryEntry[],
      nfl: injuriesNfl as unknown as InjuryEntry[],
    };

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
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    const fallback = await readProcessedFallback();
    return NextResponse.json(applyFiltersToSummary(fallback, league, conference), { headers: { "Cache-Control": "no-store" } });
  }
}
