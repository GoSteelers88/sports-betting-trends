import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

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
  const league = search.get("league")?.toUpperCase();
  const stat = search.get("stat");
  const player = search.get("player")?.toLowerCase();
  const oddsType = search.get("oddsType") ?? "standard";
  const includePromo = search.get("includePromo") === "1";

  let props = Array.isArray(env.data) ? env.data : [];
  props = props.filter((p) => p.oddsType === oddsType || oddsType === "all");
  if (!includePromo) props = props.filter((p) => !p.isPromo);
  if (league) props = props.filter((p) => p.league === league);
  if (stat) props = props.filter((p) => p.stat.toLowerCase() === stat.toLowerCase());
  if (player) props = props.filter((p) => p.player.toLowerCase().includes(player));

  return NextResponse.json({
    generatedAt: env.generatedAt,
    status: env.status,
    count: props.length,
    filters: { league, stat, player, oddsType, includePromo },
    props,
  });
}
