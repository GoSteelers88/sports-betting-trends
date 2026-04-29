import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const revalidate = 300;

const PROCESSED_DIR = path.join(process.cwd(), "data", "processed");

function readJson(file: string) {
  const p = path.join(PROCESSED_DIR, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export async function GET() {
  const mlb = readJson("picks-today.json");
  const nba = readJson("picks-nba-today.json");
  const health = readJson("sports-ingest-health.json");

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    mlb: mlb ?? { error: "picks-today.json not found" },
    nba: nba ?? { error: "picks-nba-today.json not found" },
    health: health ?? { error: "sports-ingest-health.json not found" },
  });
}
