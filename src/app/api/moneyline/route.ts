import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const PROCESSED_DIR = path.join(process.cwd(), "data", "processed");

export async function GET(req: NextRequest) {
  const p = path.join(PROCESSED_DIR, "scrape-moneyline.json");
  if (!fs.existsSync(p)) return NextResponse.json({ error: "scrape-moneyline.json not found" }, { status: 404 });
  try {
    const env = JSON.parse(fs.readFileSync(p, "utf-8"));
    const league = req.nextUrl.searchParams.get("league")?.toUpperCase();
    if (league && Array.isArray(env.data)) {
      env.data = env.data.filter((g: { league?: string }) => g.league === league);
    }
    return NextResponse.json(env);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
