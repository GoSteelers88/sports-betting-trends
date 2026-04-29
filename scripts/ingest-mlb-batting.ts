/**
 * ingest-mlb-batting.ts
 * Fetches 2026 season team batting stats (OPS, OBP, SLG, AVG) from the official MLB Stats API.
 * Output: data/processed/mlb-batting.json
 *
 * MLB Stats API (no key required):
 *   GET https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=hitting&season=2026&sportIds=1
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const OUT = path.join(root, "data/processed/mlb-batting.json");
const TIMEOUT_MS = 10_000;
const BASE_URL = "https://statsapi.mlb.com/api/v1";

type BattingEntry = {
  ops: number | null;
  obp: number | null;
  slg: number | null;
  avg: number | null;
  gamesPlayed: number;
};

type OutputShape = {
  fetchedAt: string;
  teams: Record<string, BattingEntry>;
};

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[mlb-batting] HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[mlb-batting] Fetch error for ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function parseFloat_(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function run() {
  console.log("[mlb-batting] Fetching 2026 season team batting stats from MLB Stats API...");

  const leagueUrl = `${BASE_URL}/teams/stats?stats=season&group=hitting&season=2026&sportIds=1`;
  const data = await fetchJson(leagueUrl) as Record<string, unknown> | null;

  if (!data) {
    console.warn("[mlb-batting] Failed to fetch from MLB Stats API — writing empty output");
    const empty: OutputShape = { fetchedAt: new Date().toISOString(), teams: {} };
    fs.writeFileSync(OUT, JSON.stringify(empty, null, 2));
    return;
  }

  const statsArr = (data.stats as Array<Record<string, unknown>> | undefined) ?? [];
  if (!statsArr.length) {
    console.warn("[mlb-batting] No stats array in response — writing empty output");
    console.log("[mlb-batting] Response keys:", Object.keys(data));
    const empty: OutputShape = { fetchedAt: new Date().toISOString(), teams: {} };
    fs.writeFileSync(OUT, JSON.stringify(empty, null, 2));
    return;
  }

  const statBlock = statsArr[0] as Record<string, unknown>;
  const splits = (statBlock.splits as Array<Record<string, unknown>> | undefined) ?? [];

  if (!splits.length) {
    console.warn("[mlb-batting] No splits in stats block — writing empty output");
    const empty: OutputShape = { fetchedAt: new Date().toISOString(), teams: {} };
    fs.writeFileSync(OUT, JSON.stringify(empty, null, 2));
    return;
  }

  const teams: Record<string, BattingEntry> = {};

  for (const split of splits) {
    const teamObj = (split.team as Record<string, unknown> | undefined) ?? {};
    const teamName = (teamObj.name as string | undefined) ?? "";
    const stat = (split.stat as Record<string, unknown> | undefined) ?? {};

    if (!teamName) continue;

    const gamesPlayed = parseFloat_(stat.gamesPlayed) ?? 0;
    const ops = parseFloat_(stat.ops);
    const obp = parseFloat_(stat.obp);
    const slg = parseFloat_(stat.slg);
    const avg = parseFloat_(stat.avg);

    if (gamesPlayed < 5) {
      console.log(`[mlb-batting] ${teamName}: only ${gamesPlayed} games played — including with note`);
    }

    teams[teamName] = { ops, obp, slg, avg, gamesPlayed };
  }

  const teamCount = Object.keys(teams).length;
  console.log(`[mlb-batting] Got stats for ${teamCount} teams`);

  if (teamCount > 0) {
    const sampleEntries = Object.entries(teams).slice(0, 5);
    for (const [name, entry] of sampleEntries) {
      console.log(`  ${name}: OPS=${entry.ops}, OBP=${entry.obp}, SLG=${entry.slg}, AVG=${entry.avg}, G=${entry.gamesPlayed}`);
    }
  }

  const output: OutputShape = {
    fetchedAt: new Date().toISOString(),
    teams,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`[mlb-batting] Wrote ${teamCount} teams to ${OUT}`);
}

run().catch((err) => {
  console.error("[mlb-batting] Fatal:", err);
  process.exit(1);
});
