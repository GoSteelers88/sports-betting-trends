/**
 * scrape-pinnacle-props.ts — pull Pinnacle player-prop lines (the sharp
 * reference) from the free guest API and de-vig them.
 *
 *   npm run ingest:sharp-props
 *
 * Writes data/processed/latest-sharp-props-{sport}.json. Mirrors
 * scrape-pinnacle.ts resilience: per-sport try/catch, leave-file-on-empty.
 */
import fs from "node:fs";
import path from "node:path";
import { assembleSharpProp, type SharpProp } from "@/lib/props-board";

const BASE = "https://guest.api.arcadia.pinnacle.com/0.1";
const API_KEY = process.env.PINNACLE_API_KEY ?? "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";
const OUT_DIR = path.join(process.cwd(), "data", "processed");

const SPORTS = [
  { sport: "mlb", leagueId: 246 },
  { sport: "nba", leagueId: 487 },
];

async function pget(endpoint: string): Promise<any> {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { "X-API-Key": API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Pinnacle ${endpoint} HTTP ${res.status}`);
  return res.json();
}

async function scrapeLeague(leagueId: number): Promise<SharpProp[]> {
  const [matchups, markets] = await Promise.all([
    pget(`/leagues/${leagueId}/matchups`),
    pget(`/leagues/${leagueId}/markets/straight`),
  ]);
  const marketsByMatchup = new Map<number, any[]>();
  for (const mk of markets as any[]) {
    if (!marketsByMatchup.has(mk.matchupId)) marketsByMatchup.set(mk.matchupId, []);
    marketsByMatchup.get(mk.matchupId)!.push(mk);
  }

  const props: SharpProp[] = [];
  for (const m of matchups as any[]) {
    if (m.special?.category !== "Player Props") continue;
    const participants: any[] = m.participants ?? [];
    const over = participants.find((p) => p.name === "Over");
    const under = participants.find((p) => p.name === "Under");
    if (!over || !under) continue; // not an over/under prop (e.g. yes/no exotic)
    const market = (marketsByMatchup.get(m.id) ?? []).find((mk) => mk.key === "s;0;ou");
    if (!market) continue;
    const overPrice = market.prices?.find((p: any) => p.participantId === over.id);
    const underPrice = market.prices?.find((p: any) => p.participantId === under.id);
    if (!overPrice || !underPrice || overPrice.points == null) continue;
    const prop = assembleSharpProp({
      description: String(m.special.description ?? ""),
      units: String(m.units ?? m.special.units ?? ""),
      line: Number(overPrice.points),
      overAmerican: Number(overPrice.price),
      underAmerican: Number(underPrice.price),
      cutoffAt: String(market.cutoffAt ?? ""),
    });
    if (prop && prop.units) props.push(prop);
  }
  return props;
}

async function main() {
  for (const { sport, leagueId } of SPORTS) {
    try {
      const props = await scrapeLeague(leagueId);
      if (props.length === 0) {
        console.log(`[sharp-props] ${sport}: 0 props (off-slate?) — leaving existing file`);
        continue;
      }
      const file = path.join(OUT_DIR, `latest-sharp-props-${sport}.json`);
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), props }, null, 1));
      const units = [...new Set(props.map((p) => p.units))];
      console.log(`[sharp-props] ${sport}: ${props.length} de-vigged props (${units.join(", ")})`);
    } catch (err) {
      console.warn(`[sharp-props] ${sport} failed (non-fatal): ${(err as Error).message}`);
    }
  }
}

main();
