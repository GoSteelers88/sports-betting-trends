import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { buildFreeStatsSummary, type FreeStatLike } from "../src/lib/free-stats-summary";

const prisma = new PrismaClient();
const root = process.cwd();

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

function parseCsv<T = Record<string, string>>(csv: string): T[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const out: Record<string, string> = {};
    headers.forEach((header, i) => {
      out[header] = values[i] ?? "";
    });
    return out as T;
  });
}

function nullableNumber(value: string) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const nbaCsvPath = path.join(root, "data", "raw", "nba", "sample_team_stats.csv");
  const nflJsonPath = path.join(root, "data", "raw", "nfl", "sample_team_stats.json");
  const ncaabCsvPath = path.join(root, "data", "raw", "ncaab", "sample_team_stats.csv");

  const nbaRows = parseCsv<NBARecord>(fs.readFileSync(nbaCsvPath, "utf8"));
  const nflRows: NFLRecord[] = JSON.parse(fs.readFileSync(nflJsonPath, "utf8"));
  const ncaabRows = parseCsv<NCAABRecord>(fs.readFileSync(ncaabCsvPath, "utf8"));

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
        spread: nullableNumber(row.spread),
        atsResult: row.ats_result || null,
        won: opponentPoints == null ? null : points > opponentPoints,
        teamRank: nullableNumber(row.team_rank),
        opponentRank: nullableNumber(row.opponent_rank),
        bubbleStatus: row.bubble_status || null,
        autoBidStatus: row.auto_bid_status || null,
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

  console.log(`Ingested ${records.length} free stat rows (${ncaabRows.length} NCAAB).`);
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
