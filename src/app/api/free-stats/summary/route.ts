import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "node:fs/promises";
import path from "node:path";

type LeagueKey = "NBA" | "NFL" | string;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function avg(values: Array<number | null | undefined>) {
  const valid = values.filter((v): v is number => typeof v === "number");
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function toTrendScore(params: {
  league: LeagueKey;
  games: number;
  avgPoints: number | null;
  avgRebounds: number | null;
  avgAssists: number | null;
  avgYards: number | null;
  latestPoints: number;
  latestRebounds: number | null;
  latestAssists: number | null;
  latestYards: number | null;
}) {
  const {
    league,
    games,
    avgPoints,
    avgRebounds,
    avgAssists,
    avgYards,
    latestPoints,
    latestRebounds,
    latestAssists,
    latestYards,
  } = params;

  const pointBaseline = Math.max((avgPoints ?? latestPoints) * 0.15, 5);
  const pointMomentum = clamp((latestPoints - (avgPoints ?? latestPoints)) / pointBaseline, -1, 1);

  let supportMomentum = 0;

  if (league === "NBA") {
    const rebBase = Math.max((avgRebounds ?? latestRebounds ?? 0) * 0.18, 3);
    const astBase = Math.max((avgAssists ?? latestAssists ?? 0) * 0.2, 2);

    const rebMomentum =
      latestRebounds == null ? 0 : clamp((latestRebounds - (avgRebounds ?? latestRebounds)) / rebBase, -1, 1);
    const astMomentum =
      latestAssists == null ? 0 : clamp((latestAssists - (avgAssists ?? latestAssists)) / astBase, -1, 1);

    supportMomentum = (rebMomentum + astMomentum) / 2;
  } else {
    const yardsBase = Math.max((avgYards ?? latestYards ?? 0) * 0.12, 25);
    supportMomentum =
      latestYards == null ? 0 : clamp((latestYards - (avgYards ?? latestYards)) / yardsBase, -1, 1);
  }

  const confidence = clamp(games / 8, 0.35, 1);
  const weighted = pointMomentum * 0.7 + supportMomentum * 0.3;
  const score = Math.round(clamp(50 + weighted * 35 * confidence, 1, 99));

  const signal = score >= 62 ? "up" : score <= 38 ? "down" : "flat";

  return { score, signal, confidence: Number(confidence.toFixed(2)) };
}

async function readProcessedFallback() {
  const fallbackPath = path.join(process.cwd(), "data", "processed", "latest-summary.json");
  const raw = await readFile(fallbackPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    generatedAt?: string;
    recordsIngested?: number;
    leagues?: unknown[];
    latestByLeague?: unknown[];
  };

  return {
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    ready: Array.isArray(parsed.leagues) && parsed.leagues.length > 0,
    recordsIngested: parsed.recordsIngested ?? 0,
    leagues: parsed.leagues ?? [],
    latestByLeague: parsed.latestByLeague ?? [],
    source: "processed-fallback",
  };
}

export async function GET() {
  try {
    const grouped = await prisma.freeStat.groupBy({
      by: ["league"],
      _count: { _all: true },
      _avg: {
        points: true,
        rebounds: true,
        assists: true,
        yards: true,
      },
    });

    const all = await prisma.freeStat.findMany({
      orderBy: [{ league: "asc" }, { gameDate: "desc" }],
      select: {
        league: true,
        gameDate: true,
        team: true,
        opponent: true,
        points: true,
        rebounds: true,
        assists: true,
        yards: true,
        source: true,
      },
    });

    const recentByLeague = all.reduce<Record<string, typeof all>>((acc, row) => {
      if (!acc[row.league]) acc[row.league] = [];
      if (acc[row.league].length < 5) acc[row.league].push(row);
      return acc;
    }, {});

    const leagues = grouped.map((g) => {
      const recent = recentByLeague[g.league] ?? [];
      const latest = recent[0];

      const recentAvgPoints = avg(recent.map((r) => r.points));
      const recentAvgYards = avg(recent.map((r) => r.yards));

      const trend = latest
        ? toTrendScore({
            league: g.league,
            games: g._count._all,
            avgPoints: g._avg.points,
            avgRebounds: g._avg.rebounds,
            avgAssists: g._avg.assists,
            avgYards: g._avg.yards,
            latestPoints: latest.points,
            latestRebounds: latest.rebounds,
            latestAssists: latest.assists,
            latestYards: latest.yards,
          })
        : { score: 50, signal: "flat", confidence: 0.35 };

      return {
        league: g.league,
        games: g._count._all,
        avgPoints: g._avg.points,
        avgRebounds: g._avg.rebounds,
        avgAssists: g._avg.assists,
        avgYards: g._avg.yards,
        recentAvgPoints,
        recentAvgYards,
        trendScore: trend.score,
        trendSignal: trend.signal,
        confidence: trend.confidence,
      };
    });

    const latestByLeague = Object.values(recentByLeague)
      .map((rows) => rows[0])
      .filter(Boolean)
      .sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      ready: leagues.length > 0,
      recordsIngested: all.length,
      leagues,
      latestByLeague,
      source: "prisma",
    });
  } catch {
    const fallback = await readProcessedFallback();
    return NextResponse.json(fallback);
  }
}
