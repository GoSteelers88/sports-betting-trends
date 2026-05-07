// Wraps `npm run ingest:*` scripts so the orchestrator can refresh stale data.
// Quota-aware: enforces a per-script cooldown so the agent can't burn through
// 500 monthly Odds API requests in a tight loop.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COOLDOWN_FILE = path.resolve(process.cwd(), "data", "processed", ".ingest-cooldowns.json");
const COOLDOWN_MIN_MS = 90 * 60 * 1000; // 90 min between runs of the same script

// Allowed scripts the orchestrator can run. Restricted to the agent's scope
// (NBA + MLB + their inputs). Note: `ingest:odds` hits The Odds API for ALL
// configured leagues — if you want to limit it, set THE_ODDS_LEAGUES_AGENT
// in env (handled by ingest-odds-api.ts patches in a later iteration).
export const ALLOWED_SCRIPTS = [
  "ingest:odds",
  "ingest:injuries",
  "ingest:nba-efficiency",
  "ingest:mlb-pitchers",
  "ingest:mlb-bullpen",
  "ingest:mlb-batting",
  "ingest:mlb-model",
] as const;

export type IngestScript = (typeof ALLOWED_SCRIPTS)[number];

export type IngestResult = {
  script: IngestScript;
  ranAt: string;
  status: "ok" | "skipped_cooldown" | "failed";
  durationMs: number;
  exitCode: number | null;
  cooldownRemainingMs: number;
  stdout: string;
  stderr: string;
};

type CooldownState = Record<string, number>;

function loadCooldowns(): CooldownState {
  try {
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8")) as CooldownState;
  } catch {
    return {};
  }
}

function saveCooldowns(state: CooldownState): void {
  try {
    fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

export function runIngest(script: IngestScript): IngestResult {
  if (!ALLOWED_SCRIPTS.includes(script)) {
    return {
      script,
      ranAt: new Date().toISOString(),
      status: "failed",
      durationMs: 0,
      exitCode: null,
      cooldownRemainingMs: 0,
      stdout: "",
      stderr: `script "${script}" not in allow-list`,
    };
  }

  const cooldowns = loadCooldowns();
  const lastRun = cooldowns[script] ?? 0;
  const sinceLast = Date.now() - lastRun;
  if (sinceLast < COOLDOWN_MIN_MS) {
    return {
      script,
      ranAt: new Date().toISOString(),
      status: "skipped_cooldown",
      durationMs: 0,
      exitCode: null,
      cooldownRemainingMs: COOLDOWN_MIN_MS - sinceLast,
      stdout: "",
      stderr: `cooldown active — ${Math.ceil((COOLDOWN_MIN_MS - sinceLast) / 60000)}m remaining`,
    };
  }

  const startedAt = Date.now();
  const isWin = process.platform === "win32";
  const proc = spawnSync(isWin ? "npm.cmd" : "npm", ["run", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5 * 60 * 1000, // 5 min hard ceiling
    shell: false,
    env: { ...process.env, NO_COLOR: "1" },
  });

  cooldowns[script] = Date.now();
  saveCooldowns(cooldowns);

  return {
    script,
    ranAt: new Date(startedAt).toISOString(),
    status: proc.status === 0 ? "ok" : "failed",
    durationMs: Date.now() - startedAt,
    exitCode: proc.status,
    cooldownRemainingMs: 0,
    stdout: (proc.stdout ?? "").slice(-4000),
    stderr: (proc.stderr ?? "").slice(-2000),
  };
}

export function runIngestParallel(scripts: IngestScript[]): IngestResult[] {
  // Sequential for now — npm scripts on Windows can step on each other if
  // they touch the same files concurrently. Easy upgrade to Promise.all later.
  return scripts.map(runIngest);
}
