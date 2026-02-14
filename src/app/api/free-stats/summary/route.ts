import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildFreeStatsSummary, type FreeStatLike } from "@/lib/free-stats-summary";

type SummaryShape = {
  leagues?: Array<{ league?: string }>;
  latestByLeague?: Array<{ league?: string; conference?: string | null }>;
  bestBets?: Array<{ league?: string; conference?: string | null }>;
  conferences?: string[];
  [key: string]: unknown;
};

async function readProcessedFallback() {
  const fallbackPath = path.join(process.cwd(), "data", "processed", "latest-summary.json");
  const raw = await readFile(fallbackPath, "utf-8");
  const parsed = JSON.parse(raw) as SummaryShape;
  return {
    ...parsed,
    source: "processed-fallback",
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
      },
    });

    if (all.length === 0) {
      const fallback = await readProcessedFallback();
      return NextResponse.json(applyFiltersToSummary(fallback, league, conference));
    }

    const rows: FreeStatLike[] = all.map((r) => ({ ...r }));
    const summary = buildFreeStatsSummary(rows);

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
      conferences: conferenceUniverse.map((c) => c.conference).filter(Boolean),
      filtersApplied: {
        league: league ?? "ALL",
        conference: conference ?? "ALL",
      },
      source: "prisma",
    });
  } catch {
    const fallback = await readProcessedFallback();
    return NextResponse.json(applyFiltersToSummary(fallback, league, conference));
  }
}
