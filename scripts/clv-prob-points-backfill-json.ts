/**
 * clv-prob-points-backfill-json.ts — add clvProbPoints to the JSON-backed books.
 *
 * Companion to clv-prob-points-migrate.ts (which handles the AgentPick table).
 * Same reason: `clvCents` stored a raw subtraction of American odds, which is
 * invalid across the ±100 boundary. Sign survives, magnitude does not, so any
 * average taken over these logs is wrong.
 *
 * Idempotent — recomputes from the stored prices every run.
 *
 *   npx tsx scripts/clv-prob-points-backfill-json.ts [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { clvProbPoints } from "@/lib/devig";

const DIR = path.join(process.cwd(), "data", "processed");
const dry = process.argv.includes("--dry");

function pp(taken: unknown, close: unknown): number | null {
  if (typeof taken !== "number" || typeof close !== "number") return null;
  const v = clvProbPoints(taken, close);
  return Number.isFinite(v) ? +v.toFixed(4) : null;
}

function loadJson(file: string): unknown | null {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) {
    console.log(`[backfill] ${file} — absent, skipping`);
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function save(file: string, data: unknown, changed: number, total: number): void {
  console.log(`[backfill] ${file} — ${dry ? "would set" : "set"} clvProbPoints on ${changed}/${total}`);
  if (!dry && changed > 0) {
    fs.writeFileSync(path.join(DIR, file), JSON.stringify(data, null, 2) + "\n");
  }
}

// ── clv-proof-log.json — { updatedAt, entries: [...] } ───────────────────────
{
  const file = "clv-proof-log.json";
  const doc = loadJson(file) as { entries?: Array<Record<string, unknown>> } | null;
  const j = doc?.entries;
  if (j) {
    let changed = 0;
    const vals: number[] = [];
    for (const e of j) {
      const v = pp(e.entrySoftPrice, e.closeSharpFairAmerican);
      if (v !== null) {
        e.clvProbPoints = v;
        vals.push(v);
        changed++;
      } else if (!("clvProbPoints" in e)) {
        e.clvProbPoints = null;
      }
    }
    save(file, doc, changed, j.length);
    // Report the corrected picture for the entries that would actually be bet.
    const bet = j.filter((e) => e.wouldBet && e.settled && typeof e.clvProbPoints === "number");
    if (bet.length) {
      const m = bet.reduce((a, e) => a + (e.clvProbPoints as number), 0) / bet.length;
      const beat = (100 * bet.filter((e) => e.beatClose).length) / bet.length;
      const cents = bet.reduce((a, e) => a + ((e.clvCents as number) ?? 0), 0) / bet.length;
      console.log(
        `[backfill]   wouldBet & settled (n=${bet.length}): beat ${beat.toFixed(1)}%  ` +
          `CORRECT mean ${m.toFixed(2)}pp   (legacy cents figure said ${cents.toFixed(1)}¢)`,
      );
    }
  }
}

// ── quant books — { bets: [...] } ────────────────────────────────────────────
for (const file of ["quant-desk-mlb-book.json", "quant-desk-nfl-book.json"]) {
  const j = loadJson(file) as { bets?: Array<Record<string, unknown>> } | null;
  if (!j?.bets) continue;
  let changed = 0;
  for (const b of j.bets) {
    const v = pp(b.priceAmerican, b.closeFairAmerican);
    if (v !== null) {
      b.clvProbPoints = v;
      changed++;
    } else if (!("clvProbPoints" in b)) {
      b.clvProbPoints = null;
    }
  }
  save(file, j, changed, j.bets.length);
}
