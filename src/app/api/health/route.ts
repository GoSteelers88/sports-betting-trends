import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const revalidate = 300;

const PROCESSED_DIR = path.join(process.cwd(), "data", "processed");

export async function GET() {
  const p = path.join(PROCESSED_DIR, "sports-ingest-health.json");
  if (!fs.existsSync(p)) return NextResponse.json({ error: "sports-ingest-health.json not found" }, { status: 404 });
  try {
    return NextResponse.json(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
