export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { assertServiceAuth } from "@/lib/assertServiceAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import latestPropsRaw from "../../../../../data/processed/latest-player-props.json";
import latestSummaryRaw from "../../../../../data/processed/latest-summary.json";
import latestOddsRaw from "../../../../../data/processed/latest-odds-api.json";

// ── Source types ─────────────────────────────────────────────────────────────

type OddsOutcome = { name: string; price: number; point?: number };
type OddsMarket = { key: string; outcomes: OddsOutcome[] };
type OddsBookmaker = { key: string; title: string; markets: OddsMarket[] };
type OddsEvent = {
  sport_key: string;
  sport_title?: string;
  commence_time?: string;
  home_team: string;
  away_team: string;
  bookmakers?: OddsBookmaker[];
};
type OddsFile = { fetchedAt?: string | null; events?: OddsEvent[] };

type PropEntry = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  marketLabel?: string;
  category?: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
};

type BestBetGame = {
  league: string;
  matchup: string;
  pickTeam: string;
  line: string | null;
  confidence: number;
  rationaleSignals: string[];
  gameDate: string | null;
};

type PropsFile = {
  generatedAt?: string | null;
  sport?: string;
  available?: boolean;
  note?: string | null;
  topProps?: PropEntry[];
};

type SummaryFile = {
  generatedAt?: string | null;
  bestBets?: BestBetGame[];
  bestBetsNote?: string | null;
};

// ── Response type ─────────────────────────────────────────────────────────────

type GameEntry = {
  rank: number;
  matchup: string;
  league: string;
  pickTeam: string;
  line: string | null;
  confidence: number;
  rationale: string[];
  gameTime: string | null;
};

type AssistantQueryResponse = {
  /** Raw upcoming games from the odds feed — always populated. */
  gamesTop5: GameEntry[];
  /** Model-computed picks (bestBets) — populated after ingest:odds+props runs. */
  gamePicks: GameEntry[];
  propsTop5: {
    rank: number;
    player: string;
    team: string | null;
    opponent: string | null;
    market: string;
    bet: string;
    line: number;
    pickSide: "over" | "under";
    odds: number | null;
    confidence: number;
    rationale: string[];
    dataQuality: string;
  }[];
  notes: {
    games: string | null;
    props: string | null;
    fallback: string | null;
  };
  dataFreshness: {
    propsGeneratedAt: string | null;
    oddsGeneratedAt: string | null;
    summaryGeneratedAt: string | null;
    propsAgeMinutes: number | null;
    oddsAgeMinutes: number | null;
    isStale: boolean;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const SPORT_KEY_MAP: Record<string, string> = {
  NBA: "basketball_nba",
  NFL: "americanfootball_nfl",
  NCAAB: "basketball_ncaab",
  MLB: "baseball_mlb",
};

function ageMinutes(isoStr: string | null | undefined): number | null {
  if (!isoStr) return null;
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 60_000);
}

function formatBet(prop: PropEntry): string {
  const side = prop.pickSide.toUpperCase();
  const odds = prop.pickSide === "over" ? prop.overPrice : prop.underPrice;
  const oddsStr = odds == null ? "" : ` @ ${odds >= 0 ? "+" : ""}${odds}`;
  return `${side} ${prop.line}${oddsStr}`;
}

/** Option B: derive game entries from raw odds events. */
function gamesFromOdds(events: OddsEvent[], leagueParam: string, top: number): GameEntry[] {
  const sportKey = SPORT_KEY_MAP[leagueParam];
  const filtered =
    leagueParam === "ALL"
      ? events
      : events.filter((e) => e.sport_key === (sportKey ?? leagueParam.toLowerCase()));

  const entries = filtered.map((event) => {
    const h2h = event.bookmakers?.[0]?.markets?.find((m) => m.key === "h2h");
    const spreads = event.bookmakers?.[0]?.markets?.find((m) => m.key === "spreads");

    // Pick the moneyline favorite (lowest/most-negative price)
    let pickTeam = event.home_team;
    let favoriteOdds: number | null = null;
    if (h2h && h2h.outcomes.length > 0) {
      const sorted = [...h2h.outcomes].sort((a, b) => a.price - b.price);
      pickTeam = sorted[0].name;
      favoriteOdds = sorted[0].price;
    }

    // Spread line for the pick team
    let line: string | null = null;
    if (spreads) {
      const sp = spreads.outcomes.find((o) => o.name === pickTeam);
      if (sp?.point != null) {
        line = `${pickTeam} ${sp.point > 0 ? "+" : ""}${sp.point}`;
      }
    }

    // Rough confidence from implied moneyline probability
    let confidence = 55;
    if (favoriteOdds != null && favoriteOdds < 0) {
      const abs = Math.abs(favoriteOdds);
      confidence = Math.round((abs / (abs + 100)) * 100);
    }

    const bookCount = event.bookmakers?.length ?? 0;
    const rationale: string[] = [
      favoriteOdds != null
        ? `Moneyline favorite (${favoriteOdds > 0 ? "+" : ""}${favoriteOdds})`
        : "Listed as home-team default",
      ...(bookCount > 0 ? [`${bookCount} bookmaker${bookCount !== 1 ? "s" : ""} listed`] : []),
    ];

    return {
      matchup: `${event.away_team} at ${event.home_team}`,
      league: event.sport_title ?? event.sport_key,
      pickTeam,
      line,
      confidence,
      rationale,
      gameTime: event.commence_time ?? null,
    };
  });

  // Sort highest confidence first, then rank
  return entries
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, top)
    .map((g, i) => ({ rank: i + 1, ...g }));
}

/** Option A: use model-computed bestBets from the summary JSON. */
function gamesFromBestBets(bestBets: BestBetGame[], leagueParam: string, top: number): GameEntry[] {
  const filtered =
    leagueParam === "ALL"
      ? bestBets
      : bestBets.filter((b) => (b.league ?? "").toUpperCase() === leagueParam);

  return filtered.slice(0, top).map((bet, i) => ({
    rank: i + 1,
    matchup: bet.matchup,
    league: bet.league,
    pickTeam: bet.pickTeam,
    line: bet.line ?? null,
    confidence: bet.confidence,
    rationale: bet.rationaleSignals ?? [],
    gameTime: bet.gameDate ?? null,
  }));
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Auth
  const authError = assertServiceAuth(req);
  if (authError) return authError;

  // Rate limit by IP
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (!checkRateLimit(ip, 30, 60_000)) {
    return new Response("Too Many Requests", { status: 429 });
  }

  // Query params
  const params = req.nextUrl.searchParams;
  const leagueParam = (params.get("league") ?? "NBA").toUpperCase();
  const category = params.get("category") ?? "all";
  const top = Math.min(Math.max(parseInt(params.get("top") ?? "5", 10) || 5, 1), 20);

  // Load bundled data
  const propsFile = latestPropsRaw as unknown as PropsFile;
  const summaryFile = latestSummaryRaw as unknown as SummaryFile;
  const oddsFile = latestOddsRaw as unknown as OddsFile;

  // gamesTop5 — Option B: raw odds (always populated)
  const allEvents = oddsFile.events ?? [];
  const gamesTop5 = gamesFromOdds(allEvents, leagueParam, top);

  // gamePicks — Option A: model bestBets (populated after ingest runs)
  const allBestBets = summaryFile.bestBets ?? [];
  const gamePicks = gamesFromBestBets(allBestBets, leagueParam, top);

  // propsTop5
  const propsAvailable = propsFile.available !== false;
  const allProps = propsFile.topProps ?? [];
  const propsLeague = (propsFile.sport ?? "").toUpperCase();
  const propsMatchLeague = leagueParam === "ALL" || propsLeague === leagueParam;
  const filteredProps = (propsMatchLeague ? allProps : []).filter(
    (p) => category === "all" || p.category === category,
  );

  const propsTop5 = filteredProps.slice(0, top).map((prop, i) => {
    const odds = prop.pickSide === "over" ? prop.overPrice : prop.underPrice;
    return {
      rank: i + 1,
      player: prop.player,
      team: prop.team ?? null,
      opponent: prop.opponent ?? null,
      market: prop.marketLabel ?? prop.market,
      bet: formatBet(prop),
      line: prop.line,
      pickSide: prop.pickSide,
      odds: odds ?? null,
      confidence: prop.confidence,
      rationale: prop.rationaleSignals ?? [],
      dataQuality: prop.category ?? "unknown",
    };
  });

  // Freshness
  const propsGeneratedAt = propsFile.generatedAt ?? null;
  const oddsGeneratedAt = oddsFile.fetchedAt ?? null;
  const summaryGeneratedAt = summaryFile.generatedAt ?? null;
  const propsAgeMinutes = ageMinutes(propsGeneratedAt);
  const oddsAgeMinutes = ageMinutes(oddsGeneratedAt);
  const isStale =
    (propsAgeMinutes != null && propsAgeMinutes > 240) ||
    (oddsAgeMinutes != null && oddsAgeMinutes > 240);

  // Notes
  const fallback =
    !propsAvailable || propsTop5.length === 0
      ? "Player props are currently unavailable. See gamesTop5 or gamePicks for game-level picks."
      : null;

  const response: AssistantQueryResponse = {
    gamesTop5,
    gamePicks,
    propsTop5,
    notes: {
      games: summaryFile.bestBetsNote ?? null,
      props: propsFile.note ?? null,
      fallback,
    },
    dataFreshness: {
      propsGeneratedAt,
      oddsGeneratedAt,
      summaryGeneratedAt,
      propsAgeMinutes,
      oddsAgeMinutes,
      isStale,
    },
  };

  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}
