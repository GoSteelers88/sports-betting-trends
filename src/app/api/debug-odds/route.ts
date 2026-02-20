import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET() {
  const oddsPath = path.join(process.cwd(), "data", "processed", "latest-odds-api.json");
  try {
    const raw = await readFile(oddsPath, "utf-8");
    const parsed = JSON.parse(raw) as { fetchedAt?: string; eventCount?: number; events?: Array<{ sport_key?: string; commence_time?: string; home_team?: string; away_team?: string }> };
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const nbaToday = (parsed.events ?? []).filter(e => e.sport_key === "basketball_nba" && new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(e.commence_time!)) === today);
    return NextResponse.json({
      ok: true,
      fetchedAt: parsed.fetchedAt,
      totalEvents: parsed.events?.length ?? 0,
      todayEt: today,
      nbaGamesToday: nbaToday.length,
      nbaGames: nbaToday.map(e => ({ home: e.home_team, away: e.away_team, commence: e.commence_time })),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err), cwd: process.cwd() });
  }
}
