// nfl-props-live-store.ts — the LIVE prop record on disk.
//
// Deliberately a SEPARATE log from prop-picks-log.jsonl. The backtest prop
// record is the training corpus and must stay uncontaminated by live rows —
// the same separation live-graded.jsonl keeps for game markets. The dream
// reads both, clearly labelled, and never merges them.

import * as fs from "node:fs";
import * as path from "node:path";
import type { GradedPropRow } from "./nfl-loop";

export function livePropsGradedPath(dir: string): string {
  return path.join(dir, "live-props-graded.jsonl");
}

export function loadLivePropRows(dir: string): GradedPropRow[] {
  const p = livePropsGradedPath(dir);
  if (!fs.existsSync(p)) return [];
  const out: GradedPropRow[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as GradedPropRow); } catch { /* skip a torn line */ }
  }
  return out;
}

/** Upsert by `.key`. Re-grading a week is therefore idempotent — a game whose
 *  box score lands late is corrected in place rather than double-counted. */
export function upsertLivePropRows(dir: string, rows: GradedPropRow[]): { added: number; replaced: number } {
  if (rows.length === 0) return { added: 0, replaced: 0 };
  fs.mkdirSync(dir, { recursive: true });
  const byKey = new Map<string, GradedPropRow>();
  for (const r of loadLivePropRows(dir)) byKey.set(r.key, r);
  let added = 0, replaced = 0;
  for (const r of rows) {
    if (byKey.has(r.key)) replaced++; else added++;
    byKey.set(r.key, r);
  }
  const all = [...byKey.values()];
  fs.writeFileSync(livePropsGradedPath(dir), all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : ""));
  return { added, replaced };
}
