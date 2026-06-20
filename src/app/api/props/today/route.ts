import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { assessFreshness, MAX_AGE_HOURS } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

const PROCESSED_DIR = path.join(process.cwd(), "data", "processed");

interface Prop {
  league: string;
  player: string;
  team: string;
  teamName: string;
  position: string | null;
  stat: string;
  line: number;
  startTime: string;
  isPromo: boolean;
  isLive: boolean;
  oddsType: string;
  projectionId: string;
  playerId: string;
}

export async function GET(req: NextRequest) {
  const p = path.join(PROCESSED_DIR, "scrape-props.json");
  if (!fs.existsSync(p)) return NextResponse.json({ error: "scrape-props.json not found" }, { status: 404 });
  let env: { data: Prop[]; generatedAt: string; status: string };
  try {
    env = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  const search = req.nextUrl.searchParams;
  // Bound free-text filters so a pathological query string can't drive an
  // expensive scan or get reflected back at length. 64 chars covers any real
  // league/stat/player name.
  const clip = (s: string | null | undefined): string | undefined =>
    s == null ? undefined : s.slice(0, 64);
  const league = clip(search.get("league"))?.toUpperCase();
  const stat = clip(search.get("stat"));
  const player = clip(search.get("player"))?.toLowerCase();
  const oddsType = clip(search.get("oddsType")) ?? "standard";
  const includePromo = search.get("includePromo") === "1";

  let props = Array.isArray(env.data) ? env.data : [];
  props = props.filter((p) => p.oddsType === oddsType || oddsType === "all");
  if (!includePromo) props = props.filter((p) => !p.isPromo);
  if (league) props = props.filter((p) => p.league === league);
  if (stat) props = props.filter((p) => p.stat.toLowerCase() === stat.toLowerCase());
  if (player) props = props.filter((p) => p.player.toLowerCase().includes(player));

  // FRESHNESS: this endpoint reads a static snapshot. The underlying scraper has
  // gone dead before (scrape-props.json frozen at 2026-05-06) and the route
  // happily served month-old props as if they were today's. Surface the age and
  // a `stale` flag so a consumer can refuse to render stale data instead of
  // trusting the bytes. We do NOT hard-404 (some consumers want the last-known
  // board) — but the staleness is now impossible to miss in the payload.
  const freshness = assessFreshness(env.generatedAt, MAX_AGE_HOURS.PROPS_QUOTE);

  return NextResponse.json({
    generatedAt: env.generatedAt,
    status: env.status,
    stale: !freshness.isFresh,
    ageHours: freshness.ageHours,
    freshnessStatus: freshness.status,
    count: props.length,
    filters: { league, stat, player, oddsType, includePromo },
    props,
  });
}
