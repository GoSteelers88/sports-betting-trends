/**
 * nfl-props-week.ts — capture the BEST available player-prop line for every
 * game in a live NFL week.
 *
 *   npm run nfl:props-week -- <season> <week> [--dry-run]
 *
 * Reads  data/private/nfl-loop/games.csv      (the week's slate + gameIds)
 *        data/private/nfl-loop/player_stats.csv (player → team/position)
 * Writes data/private/nfl-loop/live-props/<season>-REG-wk<week>.json
 *
 * This is a MARKET RECORD, not a pick list: it records what was on offer and at
 * which book, so the season builds a real prop history to learn from. No model
 * is called and no stake is implied. Grading is nfl:props-grade.
 *
 * Cost: 1 credit per market per event (1 region), and ONLY markets that
 * actually return a book are billed (measured 2026-09-17: a 5-market request
 * where one market had no book cost 4). The /events list is free.
 *
 * Boards are immutable receipts — the script refuses to overwrite one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultStateDir, loadGames, loadPlayerStats, gamesForCursor, normalizePlayerName, type GameRow, type PlayerStatRow } from "../src/lib/nfl-loop";
import { franchiseKey } from "../src/lib/nfl-receipts/teams";
import { selectBestLines, NFL_PROP_MARKET_KEYS, type OddsEvent, type BestLine } from "../src/lib/nfl-props-live";
import { writePublicPropBoard } from "../src/lib/nfl-props-public";

const B = "\x1b[1m", R = "\x1b[0m", G = "\x1b[32m", Y = "\x1b[33m", D = "\x1b[2m", C = "\x1b[36m";

function fail(msg: string): never {
  console.error(`${Y}${msg}${R}`);
  process.exit(1);
}

/** Player → team/position, taken from the most recent week a player appears in.
 *  The Odds API prop feed names players but never their team, and grading keys
 *  on player+team — without this every row grades "no-data". */
function buildResolver(stats: PlayerStatRow[], season: number) {
  const latest = new Map<string, { team: string; position: string; week: number }>();
  for (const r of stats) {
    if (r.season !== season) continue;
    const k = normalizePlayerName(r.playerName);
    const cur = latest.get(k);
    if (!cur || r.week > cur.week) latest.set(k, { team: r.team, position: r.position, week: r.week });
  }
  return (player: string) => {
    const hit = latest.get(normalizePlayerName(player));
    return hit ? { team: hit.team, position: hit.position } : null;
  };
}

async function main(): Promise<void> {
  const season = Number(process.argv[2]);
  const week = Number(process.argv[3]);
  const dryRun = process.argv.includes("--dry-run");
  if (!Number.isFinite(season) || !Number.isFinite(week)) {
    fail("usage: nfl-props-week.ts <season> <week> [--dry-run]");
  }
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) fail("THE_ODDS_API_KEY missing — run with --env-file-if-exists=.env.local --env-file=.env");

  const dir = defaultStateDir();
  const outDir = path.join(dir, "live-props");
  const outPath = path.join(outDir, `${season}-REG-wk${week}.json`);
  if (fs.existsSync(outPath) && !dryRun) {
    fail(`${path.basename(outPath)} already exists — prop boards are immutable receipts.`);
  }

  const cursor = { season, phase: "REG" as const, week };
  const games = gamesForCursor(loadGames(dir), cursor);
  if (games.length === 0) fail(`no games in games.csv for ${season} REG wk${week} — run npm run nfl:ingest`);

  const stats = loadPlayerStats(dir);
  const resolve = buildResolver(stats, season);
  const resolvable = stats.filter((s) => s.season === season).length;
  if (resolvable === 0) {
    console.log(`${Y}warn: no ${season} player rows cached — every row will grade no-data. Run npm run nfl:ingest-props-stats${R}`);
  }

  console.log(`${C}NFL props${R} — ${B}${season} REG wk${week}${R}: ${B}${games.length}${B} games${R} ${D}(${resolvable} player rows for team resolution)${R}`);

  // /events is quota-free.
  const evRes = await fetch(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events?apiKey=${apiKey}`, { signal: AbortSignal.timeout(20_000) });
  if (!evRes.ok) fail(`events HTTP ${evRes.status}`);
  const events: OddsEvent[] = await evRes.json();

  // Join each slate game to its Odds API event by franchise key pair.
  const byGame = new Map<string, OddsEvent>();
  for (const g of games) {
    const hk = franchiseKey(g.homeTeam), ak = franchiseKey(g.awayTeam);
    const hit = events.find((e) => franchiseKey(e.home_team ?? "") === hk && franchiseKey(e.away_team ?? "") === ak);
    if (hit) byGame.set(g.gameId, hit);
  }
  const unmatched = games.filter((g) => !byGame.has(g.gameId));
  if (unmatched.length) {
    console.log(`${Y}  ${unmatched.length} game(s) had no Odds API event: ${unmatched.map((g) => g.gameId).join(", ")}${R}`);
  }

  const markets = NFL_PROP_MARKET_KEYS.join(",");
  const rows: Array<BestLine & { gameId: string; matchup: string; commenceTime: string | null }> = [];
  let credits = 0;

  for (const [gameId, ev] of byGame) {
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/${ev.id}/odds?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.log(`${Y}  ${gameId}: odds HTTP ${res.status} — skipped${R}`);
      continue;
    }
    credits += Number(res.headers.get("x-requests-last") ?? 0);
    const payload: OddsEvent = await res.json();
    const best = selectBestLines(payload, resolve);
    const g = games.find((x) => x.gameId === gameId)!;
    for (const b of best) {
      rows.push({ ...b, gameId, matchup: `${g.awayTeam} @ ${g.homeTeam}`, commenceTime: payload.commence_time ?? null });
    }
    console.log(`  ${G}${gameId}${R} ${D}${g.awayTeam} @ ${g.homeTeam}${R} — ${B}${best.length}${R} best lines`);
  }

  const noTeam = rows.filter((r) => !r.team).length;
  const byStat: Record<string, number> = {};
  rows.forEach((r) => { byStat[r.stat] = (byStat[r.stat] ?? 0) + 1; });

  console.log("");
  console.log(`${B}captured${R} ${rows.length} best lines across ${byGame.size} games · ${B}${credits}${R} credits spent`);
  console.log(`  by stat: ${Object.entries(byStat).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (noTeam) console.log(`  ${Y}${noTeam} row(s) without a resolved team — these will grade no-data${R}`);

  if (dryRun) { console.log(`\n${D}--dry-run: nothing written.${R}`); return; }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    cursor,
    note: "Best available player-prop line per player/stat/side across US books. A MARKET RECORD, not model picks: confidence is the price's implied probability. Grade with npm run nfl:props-grade.",
    creditsSpent: credits,
    games: byGame.size,
    unmatchedGames: unmatched.map((g) => g.gameId),
    rows,
  }, null, 2));
  console.log(`\n${G}→ ${path.relative(process.cwd(), outPath)}${R}`);
  const pub = writePublicPropBoard(dir, season, week);
  if (pub) console.log(`${G}→ public receipt: data/processed/nfl-live/props-${season}-wk${String(week).padStart(2, "0")}.json${R} ${D}(${pub.totals.lines} lines)${R}`);
  console.log(`${D}next: grade it after the games with npm run nfl:props-grade -- ${season} ${week}${R}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
