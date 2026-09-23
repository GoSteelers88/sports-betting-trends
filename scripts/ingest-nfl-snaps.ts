/**
 * ingest-nfl-snaps.ts — nflverse snap counts (Pro Football Reference) for every
 * season the loop grades, into data/private/nfl-loop/snap_counts.csv.
 *
 *   npm run nfl:ingest-snaps            # 2019..current, re-fetches current season
 *   npm run nfl:ingest-snaps -- --all   # re-fetch every season
 *
 * Why: a box score cannot tell "played badly" from "left the game hurt". In
 * 2026 week 2 Jaxson Dart played 7 of 58 NYG snaps (12%) and Jayden Daniels 39
 * of 71 WAS snaps (55%) after 100% the week before; both were graded and
 * learned from as full games. Snap share is the free, published signal that
 * separates the two - see src/lib/nfl-injury-exits.ts.
 *
 * Source: https://github.com/nflverse/nflverse-data/releases/tag/snap_counts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultStateDir } from "../src/lib/nfl-loop";
import { snapCountsPath, SNAP_FIRST_SEASON } from "../src/lib/nfl-injury-exits";

const BASE = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts";
const C = "\x1b[36m", B = "\x1b[1m", R = "\x1b[0m", Y = "\x1b[33m";

async function fetchSeason(season: number): Promise<string[] | null> {
  const res = await fetch(`${BASE}/snap_counts_${season}.csv`, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`snap_counts_${season}.csv: HTTP ${res.status}`);
  return (await res.text()).trim().split("\n");
}

async function main(): Promise<void> {
  const dir = defaultStateDir();
  const out = snapCountsPath(dir);
  const refetchAll = process.argv.includes("--all");
  const currentSeason = new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1;

  // Keep already-cached past seasons (they never change); always refresh the current one.
  const kept = new Map<number, string[]>();
  let header: string | null = null;
  if (fs.existsSync(out) && !refetchAll) {
    const [h, ...rows] = fs.readFileSync(out, "utf8").trim().split("\n");
    header = h;
    const si = h.split(",").indexOf("season");
    for (const r of rows) {
      const s = Number(r.split(",")[si]);
      if (s < currentSeason) (kept.get(s) ?? kept.set(s, []).get(s)!).push(r);
    }
  }

  console.log(`${C}NFL snap counts${R} → ${path.relative(process.cwd(), out)}`);
  const seasons: Array<[number, string[]]> = [];
  for (let s = SNAP_FIRST_SEASON; s <= currentSeason; s++) {
    if (kept.has(s)) { seasons.push([s, kept.get(s)!]); console.log(`  ${s}: cached ${kept.get(s)!.length} rows`); continue; }
    const lines = await fetchSeason(s);
    if (!lines) { console.log(`  ${Y}${s}: not published${R}`); continue; }
    const [h, ...rows] = lines;
    if (header && h !== header) throw new Error(`snap_counts_${s}.csv header changed - refusing to mix schemas:\n${h}\nvs\n${header}`);
    header = h;
    seasons.push([s, rows]);
    console.log(`  ${s}: fetched ${B}${rows.length}${R} rows`);
  }
  if (!header) throw new Error("no snap-count seasons fetched");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = out + ".tmp";
  fs.writeFileSync(tmp, [header, ...seasons.flatMap(([, r]) => r)].join("\n") + "\n");
  fs.renameSync(tmp, out);
  console.log(`${B}${seasons.reduce((n, [, r]) => n + r.length, 0)}${R} rows across ${seasons.length} seasons`);
}

main().catch((e) => { console.error(e); process.exit(1); });
