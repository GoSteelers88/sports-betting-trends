// quant-desk/research/coverage-audit.ts — the Starlizard/Smartodds DATA-FLOOR
// step #1: programmatically inspect what the model CANNOT price given the
// current feeds, and emit a ranked DATA-ACQUISITION BACKLOG.
//
// This is DETECTED, not hardcoded. We define the markets we WANT to price
// (MARKET_REQUIREMENTS), each with the per-game feed fields it needs. Then we
// inspect the ACTUAL feed schemas at runtime (which stat keys appear in the MLB
// gamelog; which columns exist in the NFL games.csv header) and flag every
// requirement whose inputs are missing or only synthesizable. The output is a
// backlog the dream + the spec consume.
//
// Honesty: the backlog explains WHY a stat is missing (absent feed key vs
// synthesized proxy), which MARKETS it would unlock, and a coarse impact +
// difficulty estimate — never a promise that the data exists.

import fs from "node:fs";
import path from "node:path";

export type CoverageStatus =
  | "covered"          // every required field present in the feed
  | "synthesized"      // only an estimated proxy exists (e.g. Total Bases from H+HR)
  | "missing";         // ≥1 required field has zero signal in the feed

export interface MarketRequirement {
  sport: "MLB" | "NFL";
  market: string;            // the prop/market we'd like to price
  /** Per-game feed fields this market needs to be modeled honestly. */
  requiredFields: string[];
  /** Fields we can SYNTHESIZE from other present fields (proxy, flagged). */
  synthesizableFrom?: string[];
  impact: "high" | "medium" | "low";   // how much edge this market could add
  difficulty: "low" | "medium" | "high"; // how hard the data is to acquire
}

export interface BacklogItem {
  sport: "MLB" | "NFL";
  market: string;
  status: CoverageStatus;
  missingFields: string[];
  presentFields: string[];
  synthesizedFields: string[];
  unlocks: string;           // human note: which market this would unlock
  why: string;               // why it's missing/synthesized
  impact: MarketRequirement["impact"];
  difficulty: MarketRequirement["difficulty"];
  /** Rank score — higher = acquire sooner. impact↑, difficulty↓, status weight. */
  priority: number;
}

export interface CoverageAudit {
  generatedAt: string;
  mlbFeedFields: string[];
  nflFeedFields: string[];
  backlog: BacklogItem[];
  summary: {
    covered: number;
    synthesized: number;
    missing: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The markets we WANT to price, and the per-game fields each needs. This is the
// "what we wish we could model" wishlist — the audit compares it to reality.
// ─────────────────────────────────────────────────────────────────────────────

export const MARKET_REQUIREMENTS: MarketRequirement[] = [
  // — MLB batter props —
  { sport: "MLB", market: "Hits 1+/2+", requiredFields: ["batter_hits"], impact: "high", difficulty: "low" },
  { sport: "MLB", market: "Home Runs 1+", requiredFields: ["batter_home_runs"], impact: "high", difficulty: "low" },
  { sport: "MLB", market: "RBIs 1+", requiredFields: ["batter_rbis"], impact: "medium", difficulty: "low" },
  { sport: "MLB", market: "Runs 1+", requiredFields: ["batter_runs_scored"], impact: "medium", difficulty: "low" },
  {
    sport: "MLB",
    market: "Total Bases 1+/2+/3+",
    requiredFields: ["batter_doubles", "batter_triples"],
    synthesizableFrom: ["batter_hits", "batter_home_runs"],
    impact: "high",
    difficulty: "medium",
  },
  { sport: "MLB", market: "Stolen Bases 1+", requiredFields: ["batter_stolen_bases"], impact: "medium", difficulty: "medium" },
  { sport: "MLB", market: "Batter Strikeouts O/U", requiredFields: ["batter_strikeouts"], impact: "medium", difficulty: "medium" },
  { sport: "MLB", market: "Walks 1+", requiredFields: ["batter_walks"], impact: "low", difficulty: "medium" },
  // — MLB pitcher props —
  { sport: "MLB", market: "Pitcher Strikeouts O/U", requiredFields: ["pitcher_strikeouts"], impact: "high", difficulty: "low" },
  { sport: "MLB", market: "Earned Runs O/U", requiredFields: ["pitcher_earned_runs"], impact: "medium", difficulty: "low" },
  { sport: "MLB", market: "Pitcher Outs/Innings O/U", requiredFields: ["pitcher_outs"], impact: "medium", difficulty: "medium" },
  { sport: "MLB", market: "Hits Allowed O/U", requiredFields: ["pitcher_hits_allowed"], impact: "low", difficulty: "medium" },
  // — NFL (the dry-run model is power-rating only; richer markets need more) —
  { sport: "NFL", market: "Game total O/U (model-driven)", requiredFields: ["pace", "off_epa", "def_epa"], impact: "high", difficulty: "high" },
  { sport: "NFL", market: "Weather-adjusted total", requiredFields: ["temp", "wind", "roof"], impact: "medium", difficulty: "low" },
  { sport: "NFL", market: "Spread (snap-level adjusted)", requiredFields: ["snap_counts", "personnel"], impact: "high", difficulty: "high" },
  { sport: "NFL", market: "QB-injury-aware spread", requiredFields: ["qb_status"], synthesizableFrom: ["awayQb", "homeQb", "injuries"], impact: "high", difficulty: "medium" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Feed schema discovery — read the ACTUAL fields present, at runtime.
// ─────────────────────────────────────────────────────────────────────────────

/** Distinct per-game stat keys present across all MLB gamelog players. */
export function discoverMlbFeedFields(gamelogPath: string): string[] {
  if (!fs.existsSync(gamelogPath)) return [];
  let file: { players?: Record<string, { games?: Array<{ stats?: Record<string, number> }> }> };
  try {
    file = JSON.parse(fs.readFileSync(gamelogPath, "utf8"));
  } catch {
    return [];
  }
  const keys = new Set<string>();
  for (const p of Object.values(file.players ?? {})) {
    for (const g of p.games ?? []) {
      for (const k of Object.keys(g.stats ?? {})) keys.add(k);
    }
  }
  return [...keys].sort();
}

/** Column names present in the NFL games.csv header (the NFL feed schema). */
export function discoverNflFeedFields(gamesCsvPath: string): string[] {
  if (!fs.existsSync(gamesCsvPath)) return [];
  try {
    const firstLine = fs.readFileSync(gamesCsvPath, "utf8").split("\n", 1)[0] ?? "";
    return firstLine.split(",").map((c) => c.trim()).filter(Boolean).sort();
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit (pure given the discovered field sets).
// ─────────────────────────────────────────────────────────────────────────────

const IMPACT_W: Record<MarketRequirement["impact"], number> = { high: 3, medium: 2, low: 1 };
const DIFF_W: Record<MarketRequirement["difficulty"], number> = { low: 3, medium: 2, high: 1 };
const STATUS_W: Record<CoverageStatus, number> = { missing: 3, synthesized: 1, covered: 0 };

export function auditCoverage(
  mlbFields: string[],
  nflFields: string[],
  requirements: MarketRequirement[] = MARKET_REQUIREMENTS,
): CoverageAudit {
  const mlbSet = new Set(mlbFields);
  const nflSet = new Set(nflFields.map((f) => f.toLowerCase()));
  const backlog: BacklogItem[] = [];

  for (const req of requirements) {
    const present = req.sport === "MLB" ? mlbSet : nflSet;
    const has = (f: string) => present.has(req.sport === "MLB" ? f : f.toLowerCase());

    const missingFields = req.requiredFields.filter((f) => !has(f));
    const presentFields = req.requiredFields.filter((f) => has(f));

    // Synthesizable? All synth source fields present AND something is missing.
    const synthSources = req.synthesizableFrom ?? [];
    const synthAvailable = synthSources.length > 0 && synthSources.every((f) => has(f));
    const synthesizedFields = missingFields.length > 0 && synthAvailable ? missingFields : [];

    let status: CoverageStatus;
    let why: string;
    if (missingFields.length === 0) {
      status = "covered";
      why = "all required per-game fields present in the feed";
    } else if (synthAvailable) {
      status = "synthesized";
      why = `no feed key for [${missingFields.join(", ")}]; proxy synthesizable from [${synthSources.join(", ")}] — flagged as estimate, not measured`;
    } else {
      status = "missing";
      why = `feed has no signal for [${missingFields.join(", ")}] and no synthesis source available`;
    }

    const priority =
      IMPACT_W[req.impact] * 2 +
      DIFF_W[req.difficulty] +
      STATUS_W[status];

    backlog.push({
      sport: req.sport,
      market: req.market,
      status,
      missingFields,
      presentFields,
      synthesizedFields,
      unlocks: `pricing the "${req.market}" market`,
      why,
      impact: req.impact,
      difficulty: req.difficulty,
      priority,
    });
  }

  // Rank: highest priority first; within ties, missing before synthesized.
  backlog.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return STATUS_W[b.status] - STATUS_W[a.status];
  });

  const summary = backlog.reduce(
    (acc, b) => {
      acc[b.status]++;
      return acc;
    },
    { covered: 0, synthesized: 0, missing: 0 } as CoverageAudit["summary"],
  );

  return {
    generatedAt: new Date().toISOString(),
    mlbFeedFields: mlbFields,
    nflFeedFields: nflFields,
    backlog,
    summary,
  };
}

/** Run the audit against the live feeds and persist it (read-only on data). */
export function runCoverageAudit(opts: { processedDir?: string; nflDir?: string; outDir?: string } = {}): CoverageAudit {
  const processedDir = opts.processedDir ?? path.join(process.cwd(), "data", "processed");
  const nflDir = opts.nflDir ?? path.join(process.cwd(), "data", "private", "nfl-loop");
  const outDir = opts.outDir ?? path.join(processedDir, "quant-research");

  const mlbFields = discoverMlbFeedFields(path.join(processedDir, "player-gamelogs-mlb.json"));
  const nflFields = discoverNflFeedFields(path.join(nflDir, "games.csv"));
  const audit = auditCoverage(mlbFields, nflFields);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "coverage-audit.json"), JSON.stringify(audit, null, 2));
  return audit;
}

export function loadCoverageAudit(processedDir: string = path.join(process.cwd(), "data", "processed")): CoverageAudit | null {
  const p = path.join(processedDir, "quant-research", "coverage-audit.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as CoverageAudit;
  } catch {
    return null;
  }
}
