/**
 * nfl-props-grade.ts — grade a captured live prop board against real box scores.
 *
 *   npm run nfl:props-grade -- <season> <week>
 *
 * Reads  data/private/nfl-loop/live-props/<season>-REG-wk<week>.json
 *        data/private/nfl-loop/player_stats.csv  (nflverse actuals)
 * Writes data/private/nfl-loop/live-props-graded.jsonl   (upsert by key)
 *
 * Grading is the loop's own gradePropPick() — one grader for backtest and live,
 * so a "win" means the same thing in both records. Rows whose player has no box
 * score yet grade "no-data" and are corrected on the next run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultStateDir, loadPlayerStats, buildActualStatMap, gradePropPick,
  type PropPick, type GradedPropRow,
} from "../src/lib/nfl-loop";
import { upsertLivePropRows, loadLivePropRows } from "../src/lib/nfl-props-live-store";
import { impliedProb, type BestLine } from "../src/lib/nfl-props-live";
import { writePublicPropBoard } from "../src/lib/nfl-props-public";

const B = "\x1b[1m", R = "\x1b[0m", G = "\x1b[32m", Y = "\x1b[33m", D = "\x1b[2m";

async function main(): Promise<void> {
  const season = Number(process.argv[2]);
  const week = Number(process.argv[3]);
  if (!Number.isFinite(season) || !Number.isFinite(week)) {
    console.error("usage: nfl-props-grade.ts <season> <week>");
    process.exit(1);
  }
  const dir = defaultStateDir();
  const boardPath = path.join(dir, "live-props", `${season}-REG-wk${week}.json`);
  if (!fs.existsSync(boardPath)) {
    console.error(`${Y}no prop board at ${path.relative(process.cwd(), boardPath)} — capture it first with nfl:props-week${R}`);
    process.exit(1);
  }

  const board = JSON.parse(fs.readFileSync(boardPath, "utf8")) as {
    rows: Array<BestLine & { gameId: string }>;
  };
  const cursor = { season, phase: "REG" as const, week };
  const actuals = buildActualStatMap(loadPlayerStats(dir), cursor);
  if (actuals.size === 0) {
    console.log(`${Y}no ${season} REG wk${week} box scores cached — run npm run nfl:ingest-props-stats (every row will grade no-data)${R}`);
  }

  const graded: GradedPropRow[] = board.rows.map((r) => {
    const pick: PropPick = {
      player: r.player, team: r.team, position: r.position,
      stat: r.stat, threshold: r.point, side: r.side,
      confidence: impliedProb(r.priceAmerican),
      rationale: `best line ${r.side} ${r.point} @ ${r.priceAmerican >= 0 ? "+" : ""}${r.priceAmerican} (${r.book})`,
    };
    const row = gradePropPick(pick, r.gameId, cursor, actuals);
    // gradePropPick keys on gameId|player|stat because a backtest pick takes
    // exactly ONE side. This record holds BOTH sides — best-over sits at the
    // lowest number on offer and best-under at the highest, so they are not
    // mirrors and both can win. Without the side in the key every under
    // silently overwrote its over and half the record vanished.
    return { ...row, key: `${row.key}|${r.side}`, priceAmerican: r.priceAmerican, book: r.book };
  });

  const { added, replaced } = upsertLivePropRows(dir, graded);

  // Hit rate alone is misleading across mixed prices — 5% of best lines sit at
  // -200 or worse (alternate-ladder numbers), which inflate hit rate while
  // losing money. Units P&L at the recorded price is the price-aware metric.
  const profitUnits = (american: number): number =>
    american >= 0 ? american / 100 : 100 / -american;

  const tally = (rows: Array<GradedPropRow & { priceAmerican?: number }>) => {
    const t = { win: 0, loss: 0, push: 0, nodata: 0, units: 0 };
    rows.forEach((r) => {
      if (r.result === "win") { t.win++; t.units += profitUnits(r.priceAmerican ?? -110); }
      else if (r.result === "loss") { t.loss++; t.units -= 1; }
      else if (r.result === "push") t.push++;
      else t.nodata++;
    });
    t.units = Math.round(t.units * 100) / 100;
    return t;
  };
  const t = tally(graded);
  const dec = t.win + t.loss;
  console.log(`${B}${season} REG wk${week}${R}: graded ${graded.length} rows (${added} new, ${replaced} replaced)`);
  const roi = dec ? (t.units / dec) * 100 : null;
  console.log(`  ${G}${t.win}W${R}-${t.loss}L-${t.push}P · ${t.nodata} no-data · hit ${dec ? ((t.win / dec) * 100).toFixed(1) + "%" : "—"} · ${t.units >= 0 ? G : Y}${t.units >= 0 ? "+" : ""}${t.units}u${R} ${D}(ROI ${roi == null ? "—" : roi.toFixed(1) + "%"}, decisive only)${R}`);

  const byStat = new Map<string, GradedPropRow[]>();
  graded.forEach((r) => { const a = byStat.get(r.stat) ?? []; a.push(r); byStat.set(r.stat, a); });
  console.log(`\n${B}by stat${R}`);
  for (const [stat, rows] of [...byStat].sort((a, b) => b[1].length - a[1].length)) {
    const s = tally(rows), d = s.win + s.loss;
    console.log(`  ${stat.padEnd(9)} n=${String(rows.length).padStart(4)}  ${s.win}W-${s.loss}L-${s.push}P  ${s.nodata} no-data  hit ${d ? ((s.win / d) * 100).toFixed(1) + "%" : "—"}  ${s.units >= 0 ? "+" : ""}${s.units}u`);
  }
  const pub = writePublicPropBoard(dir, season, week);
  if (pub) console.log(`
${G}public receipt updated${R} — ${pub.totals.settled} settled / ${pub.totals.pending} pending`);
  const all = loadLivePropRows(dir);
  console.log(`\n${D}live prop record now ${all.length} rows total${R}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
