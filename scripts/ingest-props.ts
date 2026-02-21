import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";
import { getRequiredEnv } from "../src/lib/server-env";

const root = process.cwd();
const outDir = path.join(root, "data", "processed");
const outPath = path.join(outDir, "latest-player-props.json");
const pythonDir = path.join(root, "scripts", "python");

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
  // Probabilistic model fields
  modelMean: number;
  modelStd: number;
  modelPOver: number;
  modelPUnder: number;
  expectedValueOver: number;
  expectedValueUnder: number;
  distributionFamily: string;
  minutesMean: number | null;
  minutesStd: number | null;
  minutesPDNP: number | null;
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

// Python sidecar types
type PythonPlayerInput = {
  player: string;
  market: string;
  consensusLine: number;
  overPrices: number[];
  underPrices: number[];
  isHome: boolean | null;
  opponent: string | null;
  restDays: number | null;
  heuristicProjection: number;
  games: PlayerGame[];
};

type PythonModelResult = {
  player: string;
  market: string;
  modelMean: number;
  modelStd: number;
  modelPOver: number;
  modelPUnder: number;
  expectedValueOver: number;
  expectedValueUnder: number;
  distributionFamily: string;
  minutesMean: number | null;
  minutesStd: number | null;
  minutesPDNP: number | null;
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

function runPythonModel(players: PythonPlayerInput[]): PythonModelResult[] | null {
  const payload = { players };
  const inFile = path.join(outDir, "_props_input.json");
  const outFile = path.join(outDir, "_props_output.json");

  try {
    fs.writeFileSync(inFile, JSON.stringify(payload));
  } catch (e) {
    console.warn("[props] Failed to write Python input file:", e);
    return null;
  }

  const result = spawnSync(
    "python",
    [path.join(pythonDir, "props_model.py"), "--input", inFile, "--output", outFile],
    {
      encoding: "utf-8",
      timeout: 300_000,
      cwd: pythonDir,
    }
  );

  // Clean up input file
  try { fs.unlinkSync(inFile); } catch { /* ignore */ }

  if (result.error) {
    console.warn("[props] Python spawn error:", result.error.message);
    return null;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.slice(0, 800) ?? "";
    console.warn(`[props] Python exited with status ${result.status}:\n${stderr}`);
    return null;
  }

  try {
    const raw = fs.readFileSync(outFile, "utf-8");
    fs.unlinkSync(outFile);
    const parsed = JSON.parse(raw) as { results: PythonModelResult[]; errors: string[] };
    if (parsed.errors?.length) {
      for (const e of parsed.errors.slice(0, 3)) console.warn("[props] Python error:", e.slice(0, 200));
    }
    return parsed.results;
  } catch {
    console.warn("[props] Failed to read/parse Python output file");
    return null;
  }
}

function qualityScore(q: "high" | "medium" | "low") {
  return q === "high" ? 2 : q === "medium" ? 1 : 0;
}

async function main() {
  loadEnvConfig(root);
  const apiKey = getRequiredEnv("THE_ODDS_API_KEY");
  fs.mkdirSync(outDir, { recursive: true });

  const oddsPath = path.join(outDir, "latest-odds-api-basketball_nba.json");
  if (!fs.existsSync(oddsPath)) throw new Error("Missing latest-odds-api-basketball_nba.json. Run npm run ingest:odds first.");

  const stored = JSON.parse(fs.readFileSync(oddsPath, "utf-8")) as StoredOdds;

  function isAllStarEvent(e: StoredEvent): boolean {
    const h = e.home_team?.toLowerCase() ?? "";
    const a = e.away_team?.toLowerCase() ?? "";
    return (
      !h || !a ||
      h.includes("all-star") || a.includes("all-star") ||
      h.includes("all star") || a.includes("all star") ||
      h.startsWith("team ") || a.startsWith("team ")
    );
  }

  const events = (stored.events ?? []).filter((e) => isTodayEt(e.commence_time) && !isAllStarEvent(e));

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

  // Save player history snapshot for backtesting
  const historySnapshot: Record<string, PlayerGame[]> = {};
  for (const [k, v] of history.entries()) historySnapshot[k] = v;
  fs.writeFileSync(
    path.join(outDir, "player-history-snapshot.json"),
    JSON.stringify(historySnapshot)
  );

  // Accumulate all player-market pairs across events for batch Python call
  const pythonInputs: PythonPlayerInput[] = [];

  type PropAccumulator = {
    player: string;
    market: MarketKey;
    team: string | null;
    opponent: string | null;
    gameDate: string;
    lines: number[];
    overPrices: number[];
    underPrices: number[];
    isHome: boolean | null;
    playerGames: PlayerGame[];
    heuristicProjection: number;
    restDays: number | null;
  };

  const allAccumulators: PropAccumulator[] = [];
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

      const isHome = normalizeName(event.home_team) === normalizeName(playerGames[0]?.team ?? "") ? true : normalizeName(event.away_team) === normalizeName(playerGames[0]?.team ?? "") ? false : null;
      const opponent = isHome == null ? null : isHome ? event.away_team : event.home_team;
      const proj = buildProjection(playerGames, item.market, opponent, isHome, item.gameDate, history);

      const lastGame = playerGames[0] ? new Date(playerGames[0].date).getTime() : null;
      const upcoming = new Date(item.gameDate).getTime();
      const restDays = lastGame == null ? null : Math.round((upcoming - lastGame) / 86400000);

      allAccumulators.push({
        player: item.player,
        market: item.market,
        team: playerGames[0]?.team ?? null,
        opponent,
        gameDate: item.gameDate,
        lines: item.lines,
        overPrices: item.overPrices,
        underPrices: item.underPrices,
        isHome,
        playerGames,
        heuristicProjection: proj.projection,
        restDays,
      });

      pythonInputs.push({
        player: item.player,
        market: item.market,
        consensusLine: avg(item.lines) ?? item.lines[0] ?? 0,
        overPrices: item.overPrices,
        underPrices: item.underPrices,
        isHome,
        opponent,
        restDays,
        heuristicProjection: proj.projection,
        games: playerGames,
      });
    }
  }

  // Run Python model (batch — one call for all players)
  console.log(`[props] Running Python model for ${pythonInputs.length} player-market pairs...`);
  const pythonResults = runPythonModel(pythonInputs);
  const pythonMap = new Map<string, PythonModelResult>();
  if (pythonResults) {
    for (const r of pythonResults) {
      pythonMap.set(`${normalizeName(r.player)}|${r.market}`, r);
    }
    console.log(`[props] Python model returned ${pythonResults.length} results`);
  } else {
    console.warn("[props] Python model unavailable — using heuristic fallback for all props");
  }

  const rows: PropRow[] = [];

  for (const item of allAccumulators) {
    const playerKey = normalizeName(item.player);
    const playerGames = item.playerGames;
    const proj = buildProjection(playerGames, item.market, item.opponent, item.isHome, item.gameDate, history);

    const overProbRaw = americanToProb(avg(item.overPrices) ?? null);
    const underProbRaw = americanToProb(avg(item.underPrices) ?? null);
    const vigDenom = (overProbRaw ?? 0) + (underProbRaw ?? 0);
    const overNoVig = vigDenom > 0 ? (overProbRaw ?? 0) / vigDenom : null;
    const underNoVig = vigDenom > 0 ? (underProbRaw ?? 0) / vigDenom : null;

    const consensusLine = avg(item.lines) ?? item.lines[0] ?? 0;
    const edge = proj.projection - consensusLine;

    const stdev = proj.stdDev ?? 4;
    const zEdge = Math.abs(edge) / Math.max(1.5, stdev);
    const sampleBoost = Math.log10(Math.max(1, proj.sample + 1)) * 10;
    const sparsePenalty = proj.sample < 8 ? 18 : proj.sample < 12 ? 10 : 0;
    const missingMinutesPenalty = proj.minuteTrend === 0 ? 3 : 0;
    const confidence = Math.round(clamp(38 + zEdge * 14 + sampleBoost - sparsePenalty - missingMinutesPenalty, 28, 84));

    const dataQuality: "high" | "medium" | "low" = proj.sample >= 18 ? "high" : proj.sample >= 10 ? "medium" : "low";
    const cappedConfidence = dataQuality === "low" ? Math.min(confidence, 58) : dataQuality === "medium" ? Math.min(confidence, 72) : confidence;

    // Merge Python model results (or fallback to heuristic-derived values)
    const pyKey = `${playerKey}|${item.market}`;
    const py = pythonMap.get(pyKey);

    const modelMean = py?.modelMean ?? proj.projection;
    const modelStd = py?.modelStd ?? (proj.stdDev ?? 4);
    const modelPOver = py?.modelPOver ?? (edge >= 0 ? 0.52 : 0.48);
    const modelPUnder = py?.modelPUnder ?? (1 - modelPOver);
    const expectedValueOver = py?.expectedValueOver ?? 0;
    const expectedValueUnder = py?.expectedValueUnder ?? 0;
    const distributionFamily = py?.distributionFamily ?? "fallback";
    const minutesMean = py?.minutesMean ?? null;
    const minutesStd = py?.minutesStd ?? null;
    const minutesPDNP = py?.minutesPDNP ?? null;

    // Pick side: use Python P(over) if available, else heuristic edge
    const pickSide: PickSide = py
      ? (modelPOver >= modelPUnder ? "over" : "under")
      : (edge >= 0 ? "over" : "under");

    const rationale: string[] = [
      `Form windows: L5 ${proj.l5Avg?.toFixed(1) ?? "n/a"}, L10 ${proj.l10Avg?.toFixed(1) ?? "n/a"}, season ${proj.seasonAvg?.toFixed(1) ?? "n/a"}`,
      `Minutes trend ${proj.minuteTrend >= 0 ? "+" : ""}${proj.minuteTrend.toFixed(1)} vs season; usage trend ${proj.usageTrend >= 0 ? "+" : ""}${proj.usageTrend.toFixed(2)}`,
      `Consensus line ${consensusLine.toFixed(1)} across ${item.lines.length} books; model ${proj.projection.toFixed(1)} (${edge >= 0 ? "+" : ""}${edge.toFixed(1)} edge)`,
      overNoVig != null && underNoVig != null
        ? `No-vig implied probs: Over ${(overNoVig * 100).toFixed(1)}% / Under ${(underNoVig * 100).toFixed(1)}%`
        : "No-vig probabilities unavailable (missing two-way prices)",
      proj.restDays != null
        ? `Rest context: ${proj.restDays <= 1 ? "back-to-back" : `${proj.restDays} days rest`}`
        : "Rest context unavailable",
    ];
    if (proj.oppAllowance != null) rationale.push(`Opponent allowance proxy (${marketLabel(item.market)}): ${proj.oppAllowance.toFixed(1)}`);
    if (dataQuality !== "high") rationale.push(`Guardrail: ${dataQuality} sample quality (${proj.sample} games) → confidence capped.`);

    if (py && distributionFamily !== "fallback") {
      rationale.push(`Distribution: ${distributionFamily} | modelMean ${modelMean.toFixed(1)} ± ${modelStd.toFixed(1)} | P(over) ${(modelPOver * 100).toFixed(1)}%`);
      rationale.push(`EV: Over ${expectedValueOver >= 0 ? "+" : ""}${(expectedValueOver * 100).toFixed(1)}¢ / Under ${expectedValueUnder >= 0 ? "+" : ""}${(expectedValueUnder * 100).toFixed(1)}¢ per $1 → pick ${pickSide.toUpperCase()}`);
      if (minutesMean != null) rationale.push(`Minutes: ~${minutesMean.toFixed(1)} ± ${minutesStd?.toFixed(1) ?? "?"} min | P(DNP/limited): ${((minutesPDNP ?? 0) * 100).toFixed(1)}%`);
    } else {
      rationale.push("Model: heuristic (Python unavailable or insufficient data)");
    }

    rows.push({
      player: item.player,
      team: playerGames[0]?.team ?? null,
      opponent: item.opponent,
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
      modelProjection: Number(proj.projection.toFixed(2)),
      edgeVsLine: Number(edge.toFixed(2)),
      dataQuality,
      modelMean: Number(modelMean.toFixed(3)),
      modelStd: Number(modelStd.toFixed(3)),
      modelPOver: Number(modelPOver.toFixed(4)),
      modelPUnder: Number(modelPUnder.toFixed(4)),
      expectedValueOver: Number(expectedValueOver.toFixed(4)),
      expectedValueUnder: Number(expectedValueUnder.toFixed(4)),
      distributionFamily,
      minutesMean: minutesMean != null ? Number(minutesMean.toFixed(2)) : null,
      minutesStd: minutesStd != null ? Number(minutesStd.toFixed(2)) : null,
      minutesPDNP: minutesPDNP != null ? Number(minutesPDNP.toFixed(4)) : null,
    });
  }

  // Rank by EV (primary) → data quality (secondary) → confidence (tertiary)
  const ranked = rows.sort((a, b) => {
    const evA = Math.max(a.expectedValueOver, a.expectedValueUnder);
    const evB = Math.max(b.expectedValueOver, b.expectedValueUnder);
    if (Math.abs(evB - evA) > 0.005) return evB - evA;
    const qa = qualityScore(a.dataQuality);
    const qb = qualityScore(b.dataQuality);
    if (qb !== qa) return qb - qa;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (Math.abs(b.edgeVsLine) !== Math.abs(a.edgeVsLine)) return Math.abs(b.edgeVsLine) - Math.abs(a.edgeVsLine);
    return `${a.player}-${a.market}`.localeCompare(`${b.player}-${b.market}`);
  });

  // Deduplicate: one prop per player (best rank wins)
  const seenPlayers = new Set<string>();
  const deduped = ranked.filter((r) => {
    const key = normalizeName(r.player);
    if (seenPlayers.has(key)) return false;
    seenPlayers.add(key);
    return true;
  });

  // topProps: top 5 where model has an edge (P > 52%) or fallback to overall top 5
  const withEdge = deduped.filter((r) => r.modelPOver > 0.52 || r.modelPUnder > 0.52);
  const topProps = withEdge.length >= 5 ? withEdge.slice(0, 5) : deduped.slice(0, 5);

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
    topProps,
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
