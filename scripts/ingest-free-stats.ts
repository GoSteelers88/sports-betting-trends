import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { buildFreeStatsSummary, type FreeStatLike } from "../src/lib/free-stats-summary";
import { normalizeAtsResult, normalizeSpread } from "../src/lib/ats";

const prisma = new PrismaClient();
const root = process.cwd();

const MLB_DIVISIONS: Record<string, string> = {
  BAL: "AL East",
  BOS: "AL East",
  NYY: "AL East",
  TB: "AL East",
  TOR: "AL East",
  CWS: "AL Central",
  CLE: "AL Central",
  DET: "AL Central",
  KC: "AL Central",
  MIN: "AL Central",
  HOU: "AL West",
  LAA: "AL West",
  OAK: "AL West",
  SEA: "AL West",
  TEX: "AL West",
  ATL: "NL East",
  MIA: "NL East",
  NYM: "NL East",
  PHI: "NL East",
  WSH: "NL East",
  CHC: "NL Central",
  CIN: "NL Central",
  MIL: "NL Central",
  PIT: "NL Central",
  STL: "NL Central",
  ARI: "NL West",
  COL: "NL West",
  LAD: "NL West",
  SD: "NL West",
  SF: "NL West",
};

type NBARecord = {
  date: string;
  team: string;
  opponent: string;
  points: string;
  rebounds: string;
  assists: string;
  source: string;
};

type NFLRecord = {
  date: string;
  team: string;
  opponent: string;
  points: number;
  yards: number;
  source: string;
};

type NCAABRecord = {
  date: string;
  conference: string;
  team: string;
  opponent: string;
  points: string;
  opponent_points: string;
  rebounds: string;
  assists: string;
  spread: string;
  ats_result: string;
  team_rank: string;
  opponent_rank: string;
  bubble_status: string;
  auto_bid_status: string;
  source: string;
};

type MLBRecord = {
  date: string;
  division: string;
  team: string;
  opponent: string;
  points: string;
  opponent_points: string;
  rebounds: string;
  assists: string;
  spread: string;
  ats_result: string;
  source: string;
};

type EspnEvent = {
  id: string;
  date: string;
  competitions?: Array<{
    status?: { type?: { completed?: boolean } };
    competitors?: Array<{
      homeAway?: "home" | "away";
      score?: string;
      records?: Array<{ type?: string; summary?: string }>;
      curatedRank?: { current?: number };
      team?: { shortDisplayName?: string; displayName?: string; id?: string; abbreviation?: string };
      statistics?: Array<{ name?: string; displayValue?: string }>;
    }>;
  }>;
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current.trim());
  return out;
}

function parseCsv<T = Record<string, string>>(csv: string): T[] {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const out: Record<string, string> = {};
    headers.forEach((header, i) => {
      out[header] = values[i] ?? "";
    });
    return out as T;
  });
}

function nullableNumber(value: string | number | null | undefined) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseRecord(summary?: string | null) {
  if (!summary) return { wins: 0, losses: 0, pct: 0 };
  const m = summary.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return { wins: 0, losses: 0, pct: 0 };
  const wins = Number(m[1]);
  const losses = Number(m[2]);
  const total = wins + losses;
  return { wins, losses, pct: total > 0 ? wins / total : 0 };
}

function classifyBubbleStatus(teamRank: number | null, overallPct: number, confPct: number, conference: string) {
  const power = ["ACC", "BIG TEN", "BIG 12", "BIG EAST", "SEC", "PAC-12"].includes(conference.toUpperCase());
  if ((teamRank != null && teamRank <= 20) || (overallPct >= 0.74 && confPct >= 0.58)) return "LOCK";
  if ((teamRank != null && teamRank <= 45) || overallPct >= 0.62) return "WORK";
  if ((teamRank != null && teamRank <= 75) || (power && overallPct >= 0.48 && overallPct <= 0.64)) return "BUBBLE";
  return "OUT";
}

function classifyAutoBidStatus(confPct: number, conference: string) {
  const power = ["ACC", "BIG TEN", "BIG 12", "BIG EAST", "SEC", "PAC-12"].includes(conference.toUpperCase());
  if (confPct >= 0.72) return "AUTO_BID";
  if (!power && confPct >= 0.62) return "AUTO_BID";
  return "AT_LARGE_TRACK";
}

async function fetchEspnSummary(eventId: string) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${eventId}`;
  const res = await fetch(url, { headers: { "User-Agent": "sports-betting-trends/1.0" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Failed ESPN summary ${eventId}: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function conferenceFromSummary(summary: Record<string, unknown>) {
  const standings = summary.standings as { groups?: Array<{ header?: string }> } | undefined;
  const header = standings?.groups?.[0]?.header;
  if (!header) return "Unknown";
  return header.replace(/^\d{4}-\d{2}\s+/, "").replace(/\s+Standings$/i, "").trim() || "Unknown";
}

async function fetchNcaabRecentRows(daysBack: number): Promise<NCAABRecord[]> {
  const rows: NCAABRecord[] = [];
  const seen = new Set<string>();
  const events: EspnEvent[] = [];

  for (let d = 0; d < daysBack; d += 1) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    const date = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, "0")}${String(day.getDate()).padStart(2, "0")}`;

    const boardUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=50&limit=500&dates=${date}`;
    const boardRes = await fetch(boardUrl, { headers: { "User-Agent": "sports-betting-trends/1.0" }, signal: AbortSignal.timeout(10000) });
    if (!boardRes.ok) continue;
    const board = (await boardRes.json()) as { events?: EspnEvent[] };

    for (const event of board.events ?? []) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const competition = event.competitions?.[0];
      if (!competition?.status?.type?.completed) continue;
      if ((competition.competitors ?? []).length !== 2) continue;
      events.push(event);
    }
  }

  const chunkSize = 8;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const summaries = await Promise.all(
      chunk.map(async (event) => ({ event, summary: await fetchEspnSummary(event.id).catch(() => null) })),
    );

    for (const { event, summary } of summaries) {
      if (!summary) continue;
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      if (competitors.length !== 2) continue;

      const conference = conferenceFromSummary(summary);
      const pick = ((summary.pickcenter as Array<Record<string, unknown>> | undefined) ?? [])[0];
      const spreadValue = normalizeSpread((pick?.spread as number | string | undefined) ?? (pick?.details as string | undefined) ?? "");

      for (const comp of competitors) {
        const opponent = competitors.find((c) => c.team?.id !== comp.team?.id);
        if (!opponent) continue;

        const points = nullableNumber(comp.score) ?? 0;
        const opponentPoints = nullableNumber(opponent.score) ?? 0;
        const stats = comp.statistics ?? [];
        const rebounds = nullableNumber(stats.find((s) => s.name === "rebounds")?.displayValue ?? "");
        const assists = nullableNumber(stats.find((s) => s.name === "assists")?.displayValue ?? "");
        const teamRank = nullableNumber(comp.curatedRank?.current ?? null);
        const oppRank = nullableNumber(opponent.curatedRank?.current ?? null);

        const overall = parseRecord(comp.records?.find((r) => r.type === "total")?.summary);
        const confRecord = parseRecord(comp.records?.find((r) => r.type === "vsconf")?.summary);
        const bubbleStatus = classifyBubbleStatus(teamRank, overall.pct, confRecord.pct, conference);
        const autoBidStatus = classifyAutoBidStatus(confRecord.pct, conference);

        const teamSpread = comp.homeAway === "home" ? spreadValue : spreadValue == null ? null : -spreadValue;
        const ats = normalizeAtsResult(null, points, opponentPoints, teamSpread);

        rows.push({
          date: event.date.slice(0, 10),
          conference,
          team: comp.team?.shortDisplayName ?? comp.team?.displayName ?? "Unknown",
          opponent: opponent.team?.shortDisplayName ?? opponent.team?.displayName ?? "Unknown",
          points: String(points),
          opponent_points: String(opponentPoints),
          rebounds: rebounds == null ? "" : String(rebounds),
          assists: assists == null ? "" : String(assists),
          spread: teamSpread == null ? "" : String(teamSpread),
          ats_result: ats ?? "",
          team_rank: teamRank == null ? "" : String(teamRank),
          opponent_rank: oppRank == null ? "" : String(oppRank),
          bubble_status: bubbleStatus,
          auto_bid_status: autoBidStatus,
          source: "espn-public-api",
        });
      }
    }
  }

  return rows;
}

async function fetchMlbRecentRows(daysBack: number): Promise<MLBRecord[]> {
  const rows: MLBRecord[] = [];
  const seen = new Set<string>();

  for (let d = 0; d < daysBack; d += 1) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    const date = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, "0")}${String(day.getDate()).padStart(2, "0")}`;

    const boardUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?limit=200&dates=${date}`;
    const boardRes = await fetch(boardUrl, { headers: { "User-Agent": "sports-betting-trends/1.0" }, signal: AbortSignal.timeout(10000) });
    if (!boardRes.ok) continue;

    const board = (await boardRes.json()) as { events?: EspnEvent[] };
    for (const event of board.events ?? []) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);

      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      if (!competition?.status?.type?.completed || competitors.length !== 2) continue;

      const pick = ((competition as unknown as { odds?: Array<Record<string, unknown>> }).odds ?? [])[0] ?? undefined;
      const spreadValue = normalizeSpread((pick?.spread as number | string | undefined) ?? (pick?.details as string | undefined) ?? "");

      for (const comp of competitors) {
        const opponent = competitors.find((c) => c.team?.id !== comp.team?.id);
        if (!opponent) continue;

        const runs = nullableNumber(comp.score) ?? 0;
        const oppRuns = nullableNumber(opponent.score) ?? 0;
        const stats = comp.statistics ?? [];
        const hits = nullableNumber(stats.find((s) => s.name === "hits")?.displayValue ?? "");
        const errors = nullableNumber(stats.find((s) => s.name === "errors")?.displayValue ?? "");
        const abbr = comp.team?.abbreviation ?? comp.team?.shortDisplayName ?? "";
        const division = MLB_DIVISIONS[abbr] ?? "Unknown";

        const teamSpread = comp.homeAway === "home" ? spreadValue : spreadValue == null ? null : -spreadValue;
        const ats = normalizeAtsResult(null, runs, oppRuns, teamSpread);

        rows.push({
          date: event.date.slice(0, 10),
          division,
          team: comp.team?.shortDisplayName ?? comp.team?.displayName ?? abbr ?? "Unknown",
          opponent: opponent.team?.shortDisplayName ?? opponent.team?.displayName ?? "Unknown",
          points: String(runs),
          opponent_points: String(oppRuns),
          rebounds: hits == null ? "" : String(hits),
          assists: errors == null ? "" : String(errors),
          spread: teamSpread == null ? "" : String(teamSpread),
          ats_result: ats ?? "",
          source: "espn-public-api",
        });
      }
    }
  }

  return rows;
}

async function main() {
  const nbaCsvPath = path.join(root, "data", "raw", "nba", "sample_team_stats.csv");
  const nflJsonPath = path.join(root, "data", "raw", "nfl", "sample_team_stats.json");
  const ncaabCsvPath = path.join(root, "data", "raw", "ncaab", "sample_team_stats.csv");
  const mlbCsvPath = path.join(root, "data", "raw", "mlb", "sample_team_stats.csv");

  const nbaRows = parseCsv<NBARecord>(fs.readFileSync(nbaCsvPath, "utf8"));
  const nflRows: NFLRecord[] = JSON.parse(fs.readFileSync(nflJsonPath, "utf8"));

  const ncaabLookbackDays = Number(process.env.NCAAB_DAYS_BACK ?? "7");
  const fetchedNcaabRows = await fetchNcaabRecentRows(ncaabLookbackDays);
  const fallbackNcaabRows = fs.existsSync(ncaabCsvPath) ? parseCsv<NCAABRecord>(fs.readFileSync(ncaabCsvPath, "utf8")) : [];
  const ncaabRows = fetchedNcaabRows.length ? fetchedNcaabRows : fallbackNcaabRows;

  const mlbLookbackDays = Number(process.env.MLB_DAYS_BACK ?? "7");
  const fetchedMlbRows = await fetchMlbRecentRows(mlbLookbackDays);
  const fallbackMlbRows = fs.existsSync(mlbCsvPath) ? parseCsv<MLBRecord>(fs.readFileSync(mlbCsvPath, "utf8")) : [];
  const mlbRows = fetchedMlbRows.length ? fetchedMlbRows : fallbackMlbRows;

  fs.mkdirSync(path.join(root, "data", "raw", "ncaab"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "raw", "ncaab", "latest_espn_ncaab.json"), JSON.stringify(ncaabRows, null, 2));

  fs.mkdirSync(path.join(root, "data", "raw", "mlb"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "raw", "mlb", "latest_espn_mlb.json"), JSON.stringify(mlbRows, null, 2));

  const records = [
    ...nbaRows.map((row) => ({
      league: "NBA",
      conference: null,
      gameDate: new Date(row.date),
      team: row.team,
      opponent: row.opponent,
      points: Number(row.points),
      opponentPoints: null,
      rebounds: Number(row.rebounds),
      assists: Number(row.assists),
      yards: null,
      spread: null,
      atsResult: null,
      won: null,
      teamRank: null,
      opponentRank: null,
      bubbleStatus: null,
      autoBidStatus: null,
      source: row.source,
    })),
    ...nflRows.map((row) => ({
      league: "NFL",
      conference: null,
      gameDate: new Date(row.date),
      team: row.team,
      opponent: row.opponent,
      points: row.points,
      opponentPoints: null,
      rebounds: null,
      assists: null,
      yards: row.yards,
      spread: null,
      atsResult: null,
      won: null,
      teamRank: null,
      opponentRank: null,
      bubbleStatus: null,
      autoBidStatus: null,
      source: row.source,
    })),
    ...ncaabRows.map((row) => {
      const points = Number(row.points);
      const opponentPoints = nullableNumber(row.opponent_points);
      const spread = normalizeSpread(row.spread);
      const ats = normalizeAtsResult(row.ats_result, points, opponentPoints, spread);
      return {
        league: "NCAAB",
        conference: row.conference || null,
        gameDate: new Date(row.date),
        team: row.team,
        opponent: row.opponent,
        points,
        opponentPoints,
        rebounds: nullableNumber(row.rebounds),
        assists: nullableNumber(row.assists),
        yards: null,
        spread,
        atsResult: ats,
        won: opponentPoints == null ? null : points > opponentPoints,
        teamRank: nullableNumber(row.team_rank),
        opponentRank: nullableNumber(row.opponent_rank),
        bubbleStatus: row.bubble_status || null,
        autoBidStatus: row.auto_bid_status || null,
        source: row.source,
      };
    }),
    ...mlbRows.map((row) => {
      const runs = Number(row.points);
      const opponentRuns = nullableNumber(row.opponent_points);
      const spread = normalizeSpread(row.spread);
      const ats = normalizeAtsResult(row.ats_result, runs, opponentRuns, spread);
      return {
        league: "MLB",
        conference: row.division || null,
        gameDate: new Date(row.date),
        team: row.team,
        opponent: row.opponent,
        points: runs,
        opponentPoints: opponentRuns,
        rebounds: nullableNumber(row.rebounds),
        assists: nullableNumber(row.assists),
        yards: null,
        spread,
        atsResult: ats,
        won: opponentRuns == null ? null : runs > opponentRuns,
        teamRank: null,
        opponentRank: null,
        bubbleStatus: null,
        autoBidStatus: null,
        source: row.source,
      };
    }),
  ];

  await prisma.freeStat.deleteMany();
  await prisma.freeStat.createMany({ data: records });

  const mapped: FreeStatLike[] = records.map((r) => ({
    ...r,
    conference: r.conference ?? null,
    gameDate: new Date(r.gameDate),
  }));

  const summary = buildFreeStatsSummary(mapped);
  const processedPath = path.join(root, "data", "processed", "latest-summary.json");
  fs.writeFileSync(processedPath, JSON.stringify(summary, null, 2));

  console.log(`Ingested ${records.length} free stat rows (${ncaabRows.length} NCAAB, ${mlbRows.length} MLB).`);
  console.log(`NCAAB source used: ${fetchedNcaabRows.length ? "espn-public-api" : "fallback-csv"}`);
  console.log(`MLB source used: ${fetchedMlbRows.length ? "espn-public-api" : "fallback-csv"}`);
  console.log(`Wrote summary to ${processedPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
