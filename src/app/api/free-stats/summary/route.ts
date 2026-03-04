export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import latestProps from "../../../../../data/processed/latest-player-props.json";

type PlayerPropSummary = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  marketLabel: string;
  category: "core" | "defense" | "combo";
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
  dataQuality: "high" | "medium" | "low";
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

  return {
    ...summary,
    leagues,
    latestByLeague,
    bestBets,
    conferences: [...conferencesFromData].sort(),
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
    // Serve latest-summary.json directly — written by ingest:free with full enrichment
    // (scraped ATS, consensus, ESPN odds fallback, etc.)
    const summaryPath = path.join(process.cwd(), "data", "processed", "latest-summary.json");
    const raw = await readFile(summaryPath, "utf-8");
    const summary = JSON.parse(raw) as SummaryShape;

    const playerPropsPayload = await loadPlayerPropsSummary();

    return NextResponse.json(
      applyFiltersToSummary({ ...summary, ...playerPropsPayload }, league, conference),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Summary not available. Run npm run ingest:free to generate it." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
