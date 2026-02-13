import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

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

async function main() {
  const nbaCsvPath = path.join(root, "data", "raw", "nba", "sample_team_stats.csv");
  const nflJsonPath = path.join(root, "data", "raw", "nfl", "sample_team_stats.json");

  const nbaRaw = fs.readFileSync(nbaCsvPath, "utf8");
  const nflRaw = fs.readFileSync(nflJsonPath, "utf8");

  const nbaRows = parseCsv<NBARecord>(nbaRaw);
  const nflRows: NFLRecord[] = JSON.parse(nflRaw);

  const records = [
    ...nbaRows.map((row) => ({
      league: "NBA",
      gameDate: new Date(row.date),
      team: row.team,
      opponent: row.opponent,
      points: Number(row.points),
      rebounds: Number(row.rebounds),
      assists: Number(row.assists),
      yards: null,
      source: row.source,
    })),
    ...nflRows.map((row) => ({
      league: "NFL",
      gameDate: new Date(row.date),
      team: row.team,
      opponent: row.opponent,
      points: row.points,
      rebounds: null,
      assists: null,
      yards: row.yards,
      source: row.source,
    })),
  ];

  await prisma.freeStat.deleteMany();
  await prisma.freeStat.createMany({ data: records });

  const summary = await prisma.freeStat.groupBy({
    by: ["league"],
    _count: { _all: true },
    _avg: { points: true, rebounds: true, assists: true, yards: true },
  });

  const processedPath = path.join(root, "data", "processed", "latest-summary.json");
  fs.writeFileSync(processedPath, JSON.stringify(summary, null, 2));

  console.log(`Ingested ${records.length} free stat rows.`);
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
