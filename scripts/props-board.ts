/**
 * props-board.ts — print the player-prop +EV board and append matched rows
 * to the accumulating log (the props edge-frequency measurement).
 *
 *   npm run board:props          — board + log append
 *   npm run board:props report   — summary of the accumulated log
 *
 * Measurement-only: prices and ranks, places nothing. Floors pre-registered
 * in src/lib/props-board.ts (playable ≥3% EV, suspicious >15%).
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildPropsBoard,
  PROPS_PLAYABLE_FLOOR,
  type SharpProp,
  type SoftPropQuote,
  type PropsBoardRow,
} from "@/lib/props-board";
import { assessFreshness, MAX_AGE_HOURS } from "@/lib/data-freshness";

const DIR = path.join(process.cwd(), "data", "processed");
const LOG = path.join(DIR, "props-board-log.json");
const SPORTS = ["mlb", "nba", "wnba"];
const LEAGUE_OF: Record<string, string> = { mlb: "MLB", nba: "NBA", wnba: "WNBA" };

function loadJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function report() {
  const log = loadJson<{ entries: any[] }>(LOG) ?? { entries: [] };
  const entries = log.entries;
  const playable = entries.filter((e) => e.playable);
  const ticks = new Set(entries.map((e) => e.ts)).size;
  console.log(`props-board log — ${entries.length} matched quotes over ${ticks} ticks`);
  console.log(`  playable (EV ≥ ${PROPS_PLAYABLE_FLOOR * 100}%): ${playable.length}`);
  if (entries.length > 0) {
    const evs = entries.map((e) => e.evPct).sort((a, b) => a - b);
    console.log(
      `  EV distribution: min ${evs[0]} / median ${evs[Math.floor(evs.length / 2)]} / max ${evs[evs.length - 1]}`,
    );
  }
  const byBook: Record<string, number> = {};
  for (const e of playable) byBook[e.book] = (byBook[e.book] ?? 0) + 1;
  if (playable.length > 0) console.log(`  playable by book: ${JSON.stringify(byBook)}`);
}

function main() {
  if (process.argv[2] === "report") return report();

  const allRows: PropsBoardRow[] = [];
  for (const sport of SPORTS) {
    const sharp = loadJson<{ fetchedAt?: string; props: SharpProp[] }>(
      path.join(DIR, `latest-sharp-props-${sport}.json`),
    );
    const soft = loadJson<{ fetchedAt?: string; quotes: SoftPropQuote[] }>(
      path.join(DIR, `latest-soft-props-${sport}.json`),
    );
    if (!sharp?.props?.length || !soft?.quotes?.length) continue;

    // FRESHNESS GATE: never log a sharp↔soft match from a STALE file. If a
    // scraper dies (the soft scraper froze at 2026-05-06 once), its file keeps
    // existing with old quotes; joining a fresh side against a stale side would
    // append phantom "matches" to the permanent measurement log and poison the
    // edge-frequency stats forever. Skip the sport when either side is stale.
    const sharpF = assessFreshness(sharp.fetchedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE);
    const softF = assessFreshness(soft.fetchedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE);
    if (!sharpF.isFresh || !softF.isFresh) {
      console.warn(
        `[props-board] ${sport}: SKIP — stale feed (sharp ${sharpF.status}/${sharpF.ageHours ?? "?"}h, ` +
          `soft ${softF.status}/${softF.ageHours ?? "?"}h). Not logging stale matches.`,
      );
      continue;
    }

    allRows.push(...buildPropsBoard(sharp.props, soft.quotes, LEAGUE_OF[sport] ?? "MLB"));
  }

  if (allRows.length === 0) {
    console.log("[props-board] no sharp↔soft matches this tick");
    return;
  }

  console.log(`[props-board] ${allRows.length} matched quotes — top of board:`);
  for (const r of allRows.slice(0, 12)) {
    const tag = r.suspicious ? "SUSPICIOUS" : r.playable ? "PLAYABLE" : "";
    const hr = r.hrLike ? " 🔥HR" : "";
    console.log(
      `  ${r.evPct >= 0 ? "+" : ""}${r.evPct.toFixed(2)}%  ${r.player} ${r.propType} ${r.side} ${r.line}` +
        ` @ ${r.softAmerican > 0 ? "+" : ""}${r.softAmerican} (${r.book}) ${tag}${hr}`,
    );
  }
  const hrLikes = allRows.filter((r) => r.hrLike);
  if (hrLikes.length > 0) {
    console.log(`[props-board] 🔥 ${hrLikes.length} home-run prop(s) we like: ${hrLikes.map((r) => r.player).join(", ")}`);
  }

  const ts = new Date().toISOString();
  const log = loadJson<{ entries: any[] }>(LOG) ?? { entries: [] };
  log.entries.push(...allRows.map((r) => ({ ts, ...r })));
  // Atomic write: serialize to a temp file then rename. The log is the permanent
  // measurement record AND the parlay book's leg source — a process killed
  // mid-write (CI timeout, OOM) must never leave a truncated/corrupt JSON that
  // every downstream reader then silently degrades to `[]` on. rename() is
  // atomic on the same filesystem, so a reader sees either the old log or the
  // complete new one, never a half-written one.
  const tmp = `${LOG}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 1));
  fs.renameSync(tmp, LOG);
  console.log(
    `[props-board] logged ${allRows.length} rows (${allRows.filter((r) => r.playable).length} playable) → ${path.basename(LOG)}`,
  );
}

main();
