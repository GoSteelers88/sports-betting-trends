import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildFreeStatsSummary, type FreeStatLike } from "@/lib/free-stats-summary";

async function readProcessedFallback() {
  const fallbackPath = path.join(process.cwd(), "data", "processed", "latest-summary.json");
  const raw = await readFile(fallbackPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    ...parsed,
    source: "processed-fallback",
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
      },
    });

    if (all.length === 0) {
      const fallback = await readProcessedFallback();
      return NextResponse.json({
        ...fallback,
        filtersApplied: {
          league: league ?? "ALL",
          conference: conference ?? "ALL",
        },
      });
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

    const leagueBetCards = summary.leagues.map((l) => ({
      league: l.league,
      team: l.league,
      conference: null,
      score: l.trendScore,
      last10Momentum: l.ncaab?.last10Momentum ?? null,
      atsForm: l.ncaab?.atsForm ?? null,
      upsetAlertScore: l.ncaab?.upsetAlertScore ?? null,
      bubbleStatus: null,
      autoBidStatus: null,
    }));

    return NextResponse.json({
      ...summary,
      conferences: conferenceUniverse.map((c) => c.conference).filter(Boolean),
      bestBets: [...summary.bestBets, ...leagueBetCards].sort((a, b) => b.score - a.score).slice(0, 12),
      filtersApplied: {
        league: league ?? "ALL",
        conference: conference ?? "ALL",
      },
      source: "prisma",
    });
  } catch {
    const fallback = await readProcessedFallback();
    return NextResponse.json(fallback);
  }
}
