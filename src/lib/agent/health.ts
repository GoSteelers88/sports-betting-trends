// Pure-code data health checks. No LLM. Used by orchestrator to decide what
// (if anything) needs to be re-ingested before delegating to the analyst.

import fs from "node:fs";
import path from "node:path";
import type { AgentLeague } from "./tools";

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

const ODDS_FILE: Record<AgentLeague, string> = {
  NBA: "latest-odds-api-basketball_nba.json",
  MLB: "latest-odds-api-baseball_mlb.json",
  NCAAB: "latest-odds-api-basketball_ncaab.json",
};

const MODEL_FILE: Record<AgentLeague, string | null> = {
  NBA: "nba-model.json",
  MLB: "mlb-model-output.json",
  NCAAB: null,
};

const INJURY_FILE: Record<AgentLeague, string | null> = {
  NBA: "injuries-nba.json",
  MLB: null,
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

function statHours(file: string): number | null {
  try {
    const stats = fs.statSync(file);
    return (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
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
  const oddsAge = statHours(oddsPath);
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
  else if (oddsAge !== null && oddsAge > STALENESS_HOURS)
    reasons.push(`odds file ${oddsAge.toFixed(1)}h old (>${STALENESS_HOURS}h threshold)`);
  else if (oddsCount === 0) reasons.push(`odds file has 0 events`);

  // Model
  const modelFileName = MODEL_FILE[league];
  if (modelFileName) {
    const modelPath = path.join(PROCESSED, modelFileName);
    const model = readJson<ModelFile>(modelPath);
    const modelAge = statHours(modelPath);
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
    else if (modelAge !== null && modelAge > STALENESS_HOURS)
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
    const injAge = statHours(injuryPath);
    entries.push({
      source: "injuries",
      file: injuryFileName,
      exists: inj !== null,
      fetchedAt: inj?.fetchedAt ?? null,
      ageHours: injAge,
      eventCount: inj?.players?.length ?? null,
    });
    if (inj && injAge !== null && injAge > 24) {
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
