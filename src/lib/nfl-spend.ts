// Real-usage spend ledger for the NFL Exp 5 loop (and its Opus dream).
//
// Every Claude call in the loop logs its ACTUAL response.usage here, priced at
// list rates — no estimates. Two consumers:
//   1. The burst runner (nfl-week.ts `burst` mode) reads today's total to stop
//      at the daily budget cap.
//   2. The ledger itself is the per-week cost record that eventually feeds the
//      "is this lab +EV net of API spend" math once live CLV starts landing.
//
// File: data/private/nfl-loop/spend-log.jsonl (gitignored with the rest of the
// loop state). Append-only JSONL, one row per model call. Best-effort: a write
// failure logs and never takes down a pick run — the money guard here is the
// budget CAP read, and an unreadable log reads as "spent nothing", which the
// burst runner treats conservatively (see spendTodayUsd's error path).

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultStateDir } from "./nfl-loop";

// List prices per MTok, verified against platform.claude.com/docs pricing
// 2026-08-13. Cache columns priced per the standard multipliers (5m write
// 1.25x, read 0.1x) — the loop's calls are cache-free today, but the dream or
// a future prompt-cached lane should not silently bill at 0.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

// Unknown model → price at the highest tier we know, so a model swap that
// forgets this table OVERCOUNTS (burst stops early) rather than undercounts.
const FALLBACK = { in: 10, out: 50 };

export type UsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export function priceUsageUsd(model: string, usage: UsageLike): number {
  const p = PRICES[model] ?? FALLBACK;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input * p.in +
      output * p.out +
      cacheWrite * p.in * 1.25 +
      cacheRead * p.in * 0.1) /
    1_000_000
  );
}

function spendLogPath(): string {
  return path.join(defaultStateDir(), "spend-log.jsonl");
}

export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Append one call's real usage. label ties the row to its pipeline step
// (pick | props | reflect | dream); weekKey ties it to the cursor week.
export function logSpend(
  model: string,
  usage: UsageLike,
  label: string,
  weekKey: string,
  now: Date = new Date()
): void {
  const row = {
    at: now.toISOString(),
    date: utcDateKey(now),
    label,
    weekKey,
    model,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    usd: Number(priceUsageUsd(model, usage).toFixed(6)),
  };
  try {
    fs.appendFileSync(spendLogPath(), JSON.stringify(row) + "\n", "utf8");
  } catch (err) {
    console.error("[nfl-spend] spend log write failed (row lost):", err);
  }
}

// Sum today's (UTC) logged spend. On a read/parse error return Infinity — an
// unreadable ledger must stop the burst, not unleash it.
export function spendTodayUsd(now: Date = new Date()): number {
  const key = utcDateKey(now);
  try {
    if (!fs.existsSync(spendLogPath())) return 0;
    const lines = fs.readFileSync(spendLogPath(), "utf8").split("\n");
    let total = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { date?: string; usd?: number };
        if (row.date === key && typeof row.usd === "number") total += row.usd;
      } catch {
        // one corrupt row shouldn't poison the sum — skip it
      }
    }
    return total;
  } catch (err) {
    console.error("[nfl-spend] spend log read failed (treating as over-budget):", err);
    return Infinity;
  }
}
