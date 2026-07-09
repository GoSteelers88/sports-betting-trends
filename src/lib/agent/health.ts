// Pure-code data health checks. No LLM. Used by orchestrator to decide what
// (if anything) needs to be re-ingested before delegating to the analyst.

import fs from "node:fs";
import path from "node:path";
import type { AgentLeague } from "./tools";

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

const ODDS_FILE: Record<AgentLeague, string> = {
  NBA: "latest-odds-api-basketball_nba.json",
  MLB: "latest-odds-api-baseball_mlb.json",
  WNBA: "latest-odds-api-basketball_wnba.json",
  NHL: "latest-odds-api-icehockey_nhl.json",
  NCAAB: "latest-odds-api-basketball_ncaab.json",
};

const MODEL_FILE: Record<AgentLeague, string | null> = {
  NBA: "nba-model.json",
  MLB: "mlb-model-output.json",
  WNBA: "wnba-model.json",
  NHL: "nhl-model.json",
  NCAAB: null,
};

// Exported so scope-integration.test.ts can assert this stays in lockstep with
// the tools copy — their divergence (health had MLB:null while tools served the
// real file) was a live bug caught in review.
export const INJURY_FILE: Record<AgentLeague, string | null> = {
  NBA: "injuries-nba.json",
  WNBA: "injuries-wnba.json",
  MLB: "injuries-mlb.json",
  NHL: "injuries-nhl.json",
  NCAAB: null,
};

const STALENESS_HOURS = 4; // anything older than this is "stale"

export type DataHealthEntry = {
  source: "odds" | "model" | "injuries";
  file: string;
  exists: boolean;
  fetchedAt: string | null;
  ageHours: number | null;
  eventCount: number | null;
};

export type DataHealth = {
  league: AgentLeague;
  checkedAt: string;
  healthy: boolean;
  staleReasons: string[];
  entries: DataHealthEntry[];
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// Age (hours) from the DATA'S OWN in-file timestamp — never the filesystem
// mtime, which is untrustworthy here: the Vercel bundle resets it (→ everything
// looks stale) AND GH Actions checkout resets it to now (→ genuinely-old files
// look fresh, the inverse bug). Reads fetchedAt | generatedAt | updatedAt
// (Date.parse handles both "Z" and "+00:00").
//
// Returns:
//   number  → parsed a timestamp; age is real.
//   null    → present + parsed but NO readable timestamp (absent/unparseable).
//             Callers treat this as UNKNOWN freshness (a stale reason), NEVER
//             silent-fresh — Date.parse NaN must not slip through as recent.
export function ageHoursFromData(data: unknown): number | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const rec = data as Record<string, unknown>;
  const raw = rec.fetchedAt ?? rec.generatedAt ?? rec.updatedAt;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return (Date.now() - parsed) / (1000 * 60 * 60);
}

type OddsFile = { fetchedAt?: string; events?: unknown[] };
type ModelFile = { generatedAt?: string; results?: unknown[]; data?: { results?: unknown[] } };
type InjuryFile = { fetchedAt?: string; players?: unknown[] };

export function checkHealth(league: AgentLeague): DataHealth {
  const entries: DataHealthEntry[] = [];
  const reasons: string[] = [];

  // Odds
  const oddsPath = path.join(PROCESSED, ODDS_FILE[league]);
  const odds = readJson<OddsFile>(oddsPath);
  const oddsAge = ageHoursFromData(odds);
  const oddsCount = odds?.events?.length ?? null;
  entries.push({
    source: "odds",
    file: ODDS_FILE[league],
    exists: odds !== null,
    fetchedAt: odds?.fetchedAt ?? null,
    ageHours: oddsAge,
    eventCount: oddsCount,
  });
  if (!odds) reasons.push(`odds file missing for ${league}`);
  else if (oddsAge === null)
    reasons.push(`odds file has no freshness metadata — treat as unknown age`);
  else if (oddsAge > STALENESS_HOURS)
    reasons.push(`odds file ${oddsAge.toFixed(1)}h old (>${STALENESS_HOURS}h threshold)`);
  else if (oddsCount === 0) reasons.push(`odds file has 0 events`);

  // Model
  const modelFileName = MODEL_FILE[league];
  if (modelFileName) {
    const modelPath = path.join(PROCESSED, modelFileName);
    const model = readJson<ModelFile>(modelPath);
    const modelAge = ageHoursFromData(model);
    const modelCount = model?.results?.length ?? model?.data?.results?.length ?? null;
    entries.push({
      source: "model",
      file: modelFileName,
      exists: model !== null,
      fetchedAt: model?.generatedAt ?? null,
      ageHours: modelAge,
      eventCount: modelCount,
    });
    if (!model) reasons.push(`model file missing for ${league}`);
    else if (modelAge === null)
      reasons.push(`model file has no freshness metadata — treat as unknown age`);
    else if (modelAge > STALENESS_HOURS)
      reasons.push(`model file ${modelAge.toFixed(1)}h old`);
    else if (modelCount === 0) reasons.push(`model has 0 games`);

    // Cross-check: model vs odds count mismatch
    if (modelCount && oddsCount && Math.abs(modelCount - oddsCount) > 4) {
      reasons.push(
        `model has ${modelCount} games but odds has ${oddsCount} — large mismatch may indicate stale snapshot`
      );
    }
  }

  // Injuries
  const injuryFileName = INJURY_FILE[league];
  if (injuryFileName) {
    const injuryPath = path.join(PROCESSED, injuryFileName);
    const inj = readJson<InjuryFile>(injuryPath);
    const injAge = ageHoursFromData(inj);
    entries.push({
      source: "injuries",
      file: injuryFileName,
      exists: inj !== null,
      fetchedAt: inj?.fetchedAt ?? null,
      ageHours: injAge,
      eventCount: inj?.players?.length ?? null,
    });
    if (inj && injAge === null) {
      reasons.push(`injury file has no freshness metadata — treat as unknown age`);
    } else if (inj && injAge !== null && injAge > 24) {
      reasons.push(`injury file ${injAge.toFixed(1)}h old`);
    }
  }

  return {
    league,
    checkedAt: new Date().toISOString(),
    healthy: reasons.length === 0,
    staleReasons: reasons,
    entries,
  };
}
