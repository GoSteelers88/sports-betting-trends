import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { getRequiredEnv } from "../src/lib/server-env";

const root = process.cwd();
const outDir = path.join(root, "data", "processed");
const outPath = path.join(outDir, "latest-player-props.json");

const MARKET_KEYS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_threes",
  "player_blocks",
  "player_steals",
  "player_turnovers",
  "player_points_rebounds_assists",
  "player_points_rebounds",
  "player_points_assists",
  "player_rebounds_assists",
] as const;

type MarketKey = (typeof MARKET_KEYS)[number];

type PickSide = "over" | "under";

type PropRow = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: MarketKey;
  marketLabel: string;
  category: "core" | "defense" | "combo";
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  consensusLine: number;
  impliedOverProbNoVig: number | null;
  impliedUnderProbNoVig: number | null;
  pickSide: PickSide;
  confidence: number;
  rationaleSignals: string[];
  modelProjection: number;
  edgeVsLine: number;
  dataQuality: "high" | "medium" | "low";
};

type Output = {
  generatedAt: string;
  sport: "NBA";
  available: boolean;
  note: string | null;
  marketsAttempted: MarketKey[];
  marketsAvailable: string[];
  eventsConsidered: number;
  eventsWithProps: number;
  topProps: PropRow[];
  props: PropRow[];
};

type OddsOutcome = { name?: string; description?: string; price?: number; point?: number };
type OddsMarket = { key?: string; outcomes?: OddsOutcome[] };
type OddsBookmaker = { key: string; markets?: OddsMarket[] };
type OddsEvent = { bookmakers?: OddsBookmaker[] };

type StoredEvent = { id: string; commence_time: string; home_team: string; away_team: string };
type StoredOdds = { events?: StoredEvent[] };

type EspnScoreboardEvent = {
  id: string;
  date: string;
  competitions?: Array<{
    status?: { type?: { completed?: boolean } };
    competitors?: Array<{ homeAway?: "home" | "away"; team?: { displayName?: string } }>;
  }>;
};

type EspnStatGroup = { keys?: string[]; athletes?: Array<{ athlete?: { displayName?: string }; stats?: string[] }> };
type EspnSummary = { boxscore?: { players?: Array<{ team?: { displayName?: string }; statistics?: EspnStatGroup[] }> } };

type PlayerGame = {
  date: string;
  team: string;
  opponent: string;
  homeAway: "home" | "away" | "unknown";
  minutes: number | null;
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  threes: number | null;
  blocks: number | null;
  steals: number | null;
  turnovers: number | null;
  fga: number | null;
  fta: number | null;
};

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

function marketLabel(key: MarketKey) {
  const map: Record<MarketKey, string> = {
    player_points: "Points",
    player_rebounds: "Rebounds",
    player_assists: "Assists",
    player_threes: "3-Pointers Made",
    player_blocks: "Blocks",
    player_steals: "Steals",
    player_turnovers: "Turnovers",
    player_points_rebounds_assists: "PRA",
    player_points_rebounds: "Points + Rebounds",
    player_points_assists: "Points + Assists",
    player_rebounds_assists: "Rebounds + Assists",
  };
  return map[key];
}

function marketCategory(key: MarketKey): "core" | "defense" | "combo" {
  if (
    key === "player_points_rebounds_assists" ||
    key === "player_points_rebounds" ||
    key === "player_points_assists" ||
    key === "player_rebounds_assists"
  ) {
    return "combo";
  }
  if (key === "player_blocks" || key === "player_steals" || key === "player_turnovers") return "defense";
  return "core";
}

function americanToProb(price: number | null) {
  if (price == null) return null;
  if (price > 0) return 100 / (price + 100);
  return Math.abs(price) / (Math.abs(price) + 100);
}

function avg(nums: number[]) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function std(nums: number[]) {
  if (nums.length < 2) return null;
  const mean = avg(nums)!;
  const variance = nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function toNumber(value?: string) {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function parseMinutes(value?: string) {
  if (!value) return null;
  if (value.includes(":")) {
    const [m, s] = value.split(":").map((x) => Number.parseInt(x, 10));
    if (!Number.isFinite(m)) return null;
    return m + ((Number.isFinite(s) ? s : 0) / 60);
  }
  return toNumber(value);
}

function dayInEt(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function isTodayEt(iso: string) {
  return dayInEt(new Date(iso)) === dayInEt(new Date());
}

async function fetchScoreboard(dateYmd: string) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?limit=500&dates=${dateYmd}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return [] as EspnScoreboardEvent[];
  const data = (await res.json()) as { events?: EspnScoreboardEvent[] };
  return data.events ?? [];
}

async function fetchSummary(eventId: string) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return null;
  return (await res.json()) as EspnSummary;
}

async function fetchEventProps(apiKey: string, eventId: string) {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/basketball_nba/events/${eventId}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("markets", MARKET_KEYS.join(","));
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20000) });
  if (res.status === 401 || res.status === 403 || res.status === 422 || res.status === 404) return { data: null as OddsEvent | null, status: res.status };
  if (!res.ok) return { data: null as OddsEvent | null, status: res.status };
  return { data: (await res.json()) as OddsEvent, status: res.status };
}

function pickStat(game: PlayerGame, market: MarketKey) {
  switch (market) {
    case "player_points": return game.points;
    case "player_rebounds": return game.rebounds;
    case "player_assists": return game.assists;
    case "player_threes": return game.threes;
    case "player_blocks": return game.blocks;
    case "player_steals": return game.steals;
    case "player_turnovers": return game.turnovers;
    case "player_points_rebounds_assists": return (game.points ?? 0) + (game.rebounds ?? 0) + (game.assists ?? 0);
    case "player_points_rebounds": return (game.points ?? 0) + (game.rebounds ?? 0);
    case "player_points_assists": return (game.points ?? 0) + (game.assists ?? 0);
    case "player_rebounds_assists": return (game.rebounds ?? 0) + (game.assists ?? 0);
  }
}

function clamp(n: number, min: number, max: number) { return Math.min(max, Math.max(min, n)); }

async function buildPlayerHistory(daysBack = 75) {
  const map = new Map<string, PlayerGame[]>();
  const today = new Date();

  for (let i = 1; i <= daysBack; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const events = await fetchScoreboard(ymd);
    const completed = events.filter((e) => e.competitions?.[0]?.status?.type?.completed);

    const summaries = await Promise.allSettled(completed.map((e) => fetchSummary(e.id)));
    for (let idx = 0; idx < completed.length; idx += 1) {
      const event = completed[idx];
      const summary = summaries[idx];
      if (summary.status !== "fulfilled" || !summary.value) continue;

      const comp = event.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === "home")?.team?.displayName ?? "";
      const away = comp?.competitors?.find((c) => c.homeAway === "away")?.team?.displayName ?? "";

      const teams = summary.value.boxscore?.players ?? [];
      for (const t of teams) {
        const teamName = t.team?.displayName ?? "";
        const homeAway: "home" | "away" | "unknown" = teamName && home && normalizeName(teamName) === normalizeName(home) ? "home" : teamName && away && normalizeName(teamName) === normalizeName(away) ? "away" : "unknown";
        const opponent = homeAway === "home" ? away : homeAway === "away" ? home : "";

        const g = t.statistics?.[0];
        if (!g?.keys?.length) continue;

        const keys = g.keys;
        const idxOf = (name: string, alt?: string) => {
          const i1 = keys.indexOf(name);
          if (i1 >= 0) return i1;
          return alt ? keys.indexOf(alt) : -1;
        };

        const minIdx = idxOf("minutes", "min");
        const ptsIdx = idxOf("points");
        const rebIdx = idxOf("totalRebounds", "rebounds");
        const astIdx = idxOf("assists");
        const thrIdx = idxOf("threePointFieldGoalsMade", "threePointFieldGoals");
        const blkIdx = idxOf("blocks", "blockedShots");
        const stlIdx = idxOf("steals");
        const tovIdx = idxOf("turnovers");
        const fgaIdx = idxOf("fieldGoalsAttempted", "fga");
        const ftaIdx = idxOf("freeThrowsAttempted", "fta");

        for (const a of g.athletes ?? []) {
          const player = a.athlete?.displayName;
          if (!player) continue;
          const stats = a.stats ?? [];
          const pts = ptsIdx >= 0 ? toNumber(stats[ptsIdx]) : null;
          const reb = rebIdx >= 0 ? toNumber(stats[rebIdx]) : null;
          const ast = astIdx >= 0 ? toNumber(stats[astIdx]) : null;
          if (pts == null && reb == null && ast == null) continue;

          const key = normalizeName(player);
          const row: PlayerGame = {
            date: event.date,
            team: teamName || "",
            opponent: opponent || "",
            homeAway,
            minutes: minIdx >= 0 ? parseMinutes(stats[minIdx]) : null,
            points: pts,
            rebounds: reb,
            assists: ast,
            threes: thrIdx >= 0 ? toNumber(stats[thrIdx]) : null,
            blocks: blkIdx >= 0 ? toNumber(stats[blkIdx]) : null,
            steals: stlIdx >= 0 ? toNumber(stats[stlIdx]) : null,
            turnovers: tovIdx >= 0 ? toNumber(stats[tovIdx]) : null,
            fga: fgaIdx >= 0 ? toNumber(stats[fgaIdx]) : null,
            fta: ftaIdx >= 0 ? toNumber(stats[ftaIdx]) : null,
          };

          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(row);
        }
      }
    }
  }

  for (const rows of map.values()) rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return map;
}

function opponentAllowance(history: Map<string, PlayerGame[]>, market: MarketKey, opponent: string | null) {
  if (!opponent) return null;
  const opp = normalizeName(opponent);
  const values: number[] = [];
  for (const rows of history.values()) {
    for (const g of rows.slice(0, 25)) {
      if (normalizeName(g.opponent) !== opp) continue;
      const v = pickStat(g, market);
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    }
  }
  return values.length >= 20 ? avg(values) : null;
}

function buildProjection(rows: PlayerGame[], market: MarketKey, opponent: string | null, isHome: boolean | null, gameDate: string, globalHistory: Map<string, PlayerGame[]>) {
  const values = rows.map((r) => pickStat(r, market)).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const l5 = values.slice(0, 5);
  const l10 = values.slice(0, 10);
  const season = values;
  const l5Avg = avg(l5);
  const l10Avg = avg(l10);
  const seasonAvg = avg(season);

  const mins = rows.map((r) => r.minutes).filter((v): v is number => typeof v === "number");
  const minL5 = avg(mins.slice(0, 5));
  const minSeason = avg(mins);
  const minuteTrend = minL5 != null && minSeason != null ? minL5 - minSeason : 0;

  const usageProxySeries = rows
    .map((r) => {
      if (r.minutes == null || r.minutes <= 0) return null;
      const poss = (r.fga ?? 0) + 0.44 * (r.fta ?? 0) + (r.turnovers ?? 0);
      return poss / r.minutes;
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const usageTrend = usageProxySeries.length >= 8 ? (avg(usageProxySeries.slice(0, 5))! - avg(usageProxySeries)!) : 0;

  const homeVals = rows.filter((r) => r.homeAway === "home").map((r) => pickStat(r, market)).filter((v): v is number => typeof v === "number");
  const awayVals = rows.filter((r) => r.homeAway === "away").map((r) => pickStat(r, market)).filter((v): v is number => typeof v === "number");
  const splitAdj = isHome == null ? 0 : isHome ? ((avg(homeVals) ?? 0) - (seasonAvg ?? 0)) : ((avg(awayVals) ?? 0) - (seasonAvg ?? 0));

  const lastGame = rows[0] ? new Date(rows[0].date).getTime() : null;
  const upcoming = new Date(gameDate).getTime();
  const restDays = lastGame == null ? null : Math.round((upcoming - lastGame) / 86400000);
  const restAdj = restDays == null ? 0 : restDays <= 1 ? -0.9 : restDays >= 3 ? 0.3 : 0;

  const oppAllowance = opponentAllowance(globalHistory, market, opponent);
  const oppAdj = oppAllowance != null && seasonAvg != null ? (oppAllowance - seasonAvg) * 0.12 : 0;

  const blendedBase = (l5Avg ?? seasonAvg ?? 0) * 0.5 + (l10Avg ?? seasonAvg ?? 0) * 0.3 + (seasonAvg ?? 0) * 0.2;
  const projection = blendedBase + minuteTrend * 0.09 + usageTrend * 1.4 + splitAdj * 0.15 + restAdj + oppAdj;

  return {
    projection,
    l5Avg,
    l10Avg,
    seasonAvg,
    sample: season.length,
    stdDev: std(season),
    minuteTrend,
    usageTrend,
    restDays,
    oppAllowance,
  };
}

async function main() {
  loadEnvConfig(root);
  const apiKey = getRequiredEnv("THE_ODDS_API_KEY");
  fs.mkdirSync(outDir, { recursive: true });

  const oddsPath = path.join(outDir, "latest-odds-api-basketball_nba.json");
  if (!fs.existsSync(oddsPath)) throw new Error("Missing latest-odds-api-basketball_nba.json. Run npm run ingest:odds first.");

  const stored = JSON.parse(fs.readFileSync(oddsPath, "utf-8")) as StoredOdds;
  const events = (stored.events ?? []).filter((e) => isTodayEt(e.commence_time));

  if (!events.length) {
    const out: Output = {
      generatedAt: new Date().toISOString(),
      sport: "NBA",
      available: true,
      note: "No NBA events found for today in odds feed.",
      marketsAttempted: [...MARKET_KEYS],
      marketsAvailable: [],
      eventsConsidered: 0,
      eventsWithProps: 0,
      topProps: [],
      props: [],
    };
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    return;
  }

  const history = await buildPlayerHistory(75);
  const rows: PropRow[] = [];
  const availableMarkets = new Set<string>();
  let eventsWithProps = 0;
  let accessDenied = 0;

  for (const event of events) {
    const { data, status } = await fetchEventProps(apiKey, event.id);
    if (!data) {
      if (status === 401 || status === 403 || status === 422) accessDenied += 1;
      continue;
    }

    const byProp = new Map<string, {
      player: string;
      market: MarketKey;
      team: string | null;
      opponent: string | null;
      gameDate: string;
      lines: number[];
      overPrices: number[];
      underPrices: number[];
    }>();

    for (const book of data.bookmakers ?? []) {
      for (const market of book.markets ?? []) {
        if (!market.key || !MARKET_KEYS.includes(market.key as MarketKey)) continue;
        const mk = market.key as MarketKey;
        availableMarkets.add(mk);

        for (const outcome of market.outcomes ?? []) {
          const player = outcome.description?.trim();
          if (!player || outcome.point == null) continue;
          const key = `${normalizeName(player)}|${mk}`;
          if (!byProp.has(key)) {
            byProp.set(key, {
              player,
              market: mk,
              team: null,
              opponent: null,
              gameDate: event.commence_time,
              lines: [],
              overPrices: [],
              underPrices: [],
            });
          }
          const p = byProp.get(key)!;
          p.lines.push(outcome.point);
          if (outcome.name === "Over" && outcome.price != null) p.overPrices.push(outcome.price);
          if (outcome.name === "Under" && outcome.price != null) p.underPrices.push(outcome.price);
        }
      }
    }

    if (byProp.size > 0) eventsWithProps += 1;

    for (const item of byProp.values()) {
      const playerKey = normalizeName(item.player);
      const playerGames = history.get(playerKey) ?? [];

      const overProbRaw = americanToProb(avg(item.overPrices) ?? null);
      const underProbRaw = americanToProb(avg(item.underPrices) ?? null);
      const vigDenom = (overProbRaw ?? 0) + (underProbRaw ?? 0);
      const overNoVig = vigDenom > 0 ? (overProbRaw ?? 0) / vigDenom : null;
      const underNoVig = vigDenom > 0 ? (underProbRaw ?? 0) / vigDenom : null;

      const isHome = normalizeName(event.home_team) === normalizeName(playerGames[0]?.team ?? "") ? true : normalizeName(event.away_team) === normalizeName(playerGames[0]?.team ?? "") ? false : null;
      const opponent = isHome == null ? null : isHome ? event.away_team : event.home_team;
      const projection = buildProjection(playerGames, item.market, opponent, isHome, item.gameDate, history);

      const consensusLine = avg(item.lines) ?? item.lines[0] ?? 0;
      const edge = projection.projection - consensusLine;
      const pickSide: PickSide = edge >= 0 ? "over" : "under";

      const stdev = projection.stdDev ?? 4;
      const zEdge = Math.abs(edge) / Math.max(1.5, stdev);
      const sampleBoost = Math.log10(Math.max(1, projection.sample + 1)) * 10;
      const sparsePenalty = projection.sample < 8 ? 18 : projection.sample < 12 ? 10 : 0;
      const missingMinutesPenalty = projection.minuteTrend === 0 ? 3 : 0;
      const confidence = Math.round(clamp(38 + zEdge * 14 + sampleBoost - sparsePenalty - missingMinutesPenalty, 28, 84));

      const dataQuality: "high" | "medium" | "low" = projection.sample >= 18 ? "high" : projection.sample >= 10 ? "medium" : "low";
      const cappedConfidence = dataQuality === "low" ? Math.min(confidence, 58) : dataQuality === "medium" ? Math.min(confidence, 72) : confidence;

      const rationale = [
        `Form windows: L5 ${projection.l5Avg?.toFixed(1) ?? "n/a"}, L10 ${projection.l10Avg?.toFixed(1) ?? "n/a"}, season ${projection.seasonAvg?.toFixed(1) ?? "n/a"}`,
        `Minutes trend ${projection.minuteTrend >= 0 ? "+" : ""}${projection.minuteTrend.toFixed(1)} vs season; usage trend ${projection.usageTrend >= 0 ? "+" : ""}${projection.usageTrend.toFixed(2)}`,
        `Consensus line ${consensusLine.toFixed(1)} across ${item.lines.length} books; model ${projection.projection.toFixed(1)} (${edge >= 0 ? "+" : ""}${edge.toFixed(1)} edge)`,
        overNoVig != null && underNoVig != null
          ? `No-vig implied probs: Over ${(overNoVig * 100).toFixed(1)}% / Under ${(underNoVig * 100).toFixed(1)}%`
          : "No-vig probabilities unavailable (missing two-way prices)",
        projection.restDays != null
          ? `Rest context: ${projection.restDays <= 1 ? "back-to-back" : `${projection.restDays} days rest`}`
          : "Rest context unavailable",
      ];
      if (projection.oppAllowance != null) rationale.push(`Opponent allowance proxy (${marketLabel(item.market)}): ${projection.oppAllowance.toFixed(1)}`);
      if (dataQuality !== "high") rationale.push(`Guardrail: ${dataQuality} sample quality (${projection.sample} games) → confidence capped.`);

      rows.push({
        player: item.player,
        team: playerGames[0]?.team ?? null,
        opponent,
        market: item.market,
        marketLabel: marketLabel(item.market),
        category: marketCategory(item.market),
        line: Number(consensusLine.toFixed(1)),
        overPrice: item.overPrices.length ? Math.round(Math.max(...item.overPrices)) : null,
        underPrice: item.underPrices.length ? Math.round(Math.max(...item.underPrices)) : null,
        consensusLine: Number(consensusLine.toFixed(2)),
        impliedOverProbNoVig: overNoVig != null ? Number(overNoVig.toFixed(4)) : null,
        impliedUnderProbNoVig: underNoVig != null ? Number(underNoVig.toFixed(4)) : null,
        pickSide,
        confidence: cappedConfidence,
        rationaleSignals: rationale,
        modelProjection: Number(projection.projection.toFixed(2)),
        edgeVsLine: Number(edge.toFixed(2)),
        dataQuality,
      });
    }
  }

  const ranked = rows
    .sort((a, b) => {
      const qa = a.dataQuality === "high" ? 2 : a.dataQuality === "medium" ? 1 : 0;
      const qb = b.dataQuality === "high" ? 2 : b.dataQuality === "medium" ? 1 : 0;
      if (qb !== qa) return qb - qa;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (Math.abs(b.edgeVsLine) !== Math.abs(a.edgeVsLine)) return Math.abs(b.edgeVsLine) - Math.abs(a.edgeVsLine);
      return `${a.player}-${a.market}`.localeCompare(`${b.player}-${b.market}`);
    });

  const available = ranked.length > 0;
  const note = !available
    ? accessDenied > 0
      ? "Player prop markets unavailable for current The Odds API plan or market access."
      : "No NBA player props returned for today."
    : null;

  const output: Output = {
    generatedAt: new Date().toISOString(),
    sport: "NBA",
    available,
    note,
    marketsAttempted: [...MARKET_KEYS],
    marketsAvailable: [...availableMarkets].sort(),
    eventsConsidered: events.length,
    eventsWithProps,
    topProps: ranked.slice(0, 5),
    props: ranked,
  };

  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2));
  fs.renameSync(tmp, outPath);
  console.log(`[props] wrote ${output.props.length} props (${output.topProps.length} top) -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

