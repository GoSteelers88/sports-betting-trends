// quant-desk/research/research-runner.ts — wires the live data into the two
// learning modules and persists the artifacts the dream + dashboard read.
//
// SAMPLES for correlation discovery come from the richest graded log we have:
// the NFL loop's picks-log.jsonl (real outcomes + pre-game dimensions), plus the
// MLB quant book's settled moneyline bets (outcome + model fair prob → residual).
// Both are quarantined research inputs; nothing here changes a live model.

import fs from "node:fs";
import path from "node:path";
import {
  loadGradedRows,
  defaultStateDir as nflStateDir,
} from "../../nfl-loop";
import { loadBook, mlbBookDir, nflBookDir } from "../store";
import { runCoverageAudit, type CoverageAudit } from "./coverage-audit";
import { scanCorrelations, type CorrelationScan, type Sample } from "./correlations";

/** Turn the NFL graded log into correlation samples. Each graded row is one
 *  decision with a real win/loss outcome and pre-game features. We exclude
 *  pushes (no decisive outcome) and encode categoricals as numeric. */
export function nflGradedToSamples(dir: string = nflStateDir()): Sample[] {
  const rows = loadGradedRows(dir);
  const out: Sample[] = [];
  for (const r of rows) {
    if (r.result === "push") continue;
    const outcome = r.result === "win" ? 1 : 0;
    out.push({
      features: {
        confidence: r.confidence,
        is_favorite: r.favored === "favorite" ? 1 : r.favored === "underdog" ? 0 : 0.5,
        is_home: r.homeAway === "home" ? 1 : 0,
        is_divisional: r.divGame ? 1 : 0,
        is_dome: r.dome ? 1 : 0,
        rest_advantage: r.restAdvantage,
        wind: r.wind ?? 0,
        temp: r.temp ?? 60,
        is_ats: r.market === "ats" ? 1 : 0,
        is_total: r.market === "total" ? 1 : 0,
        is_moneyline: r.market === "moneyline" ? 1 : 0,
      },
      outcome,
      // The NFL loop's pick has confidence, not a calibrated fair prob; use
      // confidence as the model's implied prob so residual = confidence − outcome
      // surfaces over/under-confidence patterns (a real, useful model error).
      modelFairProb: r.confidence,
    });
  }
  return out;
}

/** Turn settled quant moneyline bets into samples (outcome + true model fair
 *  prob → residual is the genuine win-prob model error). Works for either
 *  sport's book — `sport` selects which book file is read. */
export function quantBookToSamples(sport: "MLB" | "NFL", dir: string): Sample[] {
  const book = loadBook(dir, sport);
  const out: Sample[] = [];
  for (const b of book.bets) {
    if (b.status !== "won" && b.status !== "lost") continue;
    if (b.market !== "moneyline") continue;
    const outcome = b.status === "won" ? 1 : 0;
    out.push({
      features: {
        model_fair_prob: b.modelFairProb,
        devig_market_prob: b.devigMarketProb,
        edge: b.edge,
        price_american: b.priceAmerican,
        is_favorite: b.priceAmerican < 0 ? 1 : 0,
        is_estimate: b.estimate ? 1 : 0,
      },
      outcome,
      modelFairProb: b.modelFairProb,
    });
  }
  return out;
}

/** Back-compat alias for the MLB book sampler. */
export function mlbBookToSamples(dir: string = mlbBookDir()): Sample[] {
  return quantBookToSamples("MLB", dir);
}

export interface ResearchArtifacts {
  coverage: CoverageAudit;
  nflScan: CorrelationScan;
  mlbScan: CorrelationScan;
}

/** Run BOTH learning modules and persist them under data/processed/quant-research/.
 *  The NFL correlation scan stays private in spirit (it reads private NFL data)
 *  but its OUTPUT is a research artifact the dream reflects on — we keep the
 *  full NFL scan under the private dir and only a redacted summary in processed. */
export function runResearch(opts: { processedDir?: string; nflDir?: string } = {}): ResearchArtifacts {
  const processedDir = opts.processedDir ?? path.join(process.cwd(), "data", "processed");
  const nflDir = opts.nflDir ?? nflStateDir();
  const outDir = path.join(processedDir, "quant-research");
  const privateOut = path.join(nflDir, "quant");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(privateOut, { recursive: true });

  // 1) coverage audit (writes coverage-audit.json in processed)
  const coverage = runCoverageAudit({ processedDir, nflDir, outDir });

  // 2) correlation discovery
  //   NFL samples = the loop's graded picks-log (rich pre-game dimensions) PLUS
  //   the NFL dry-run book's settled moneyline bets (model-fair-prob residuals).
  //   Both are PRIVATE inputs; the merged scan stays under the private dir.
  const nflSamples = [
    ...nflGradedToSamples(nflDir),
    ...quantBookToSamples("NFL", nflBookDir()),
  ];
  const nflScan = scanCorrelations(nflSamples);
  const mlbScan = scanCorrelations(quantBookToSamples("MLB", mlbBookDir()));

  // NFL scan output is PRIVATE (reads private NFL data) — full detail stays in
  // the private quant dir; nothing NFL-identifying lands in processed.
  fs.writeFileSync(path.join(privateOut, "nfl-correlations.json"), JSON.stringify(nflScan, null, 2));
  fs.writeFileSync(path.join(outDir, "mlb-correlations.json"), JSON.stringify(mlbScan, null, 2));

  return { coverage, nflScan, mlbScan };
}

export function loadResearchSummary(processedDir: string = path.join(process.cwd(), "data", "processed")): {
  coverage: CoverageAudit | null;
  mlbScan: CorrelationScan | null;
} {
  const read = <T>(p: string): T | null => {
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const dir = path.join(processedDir, "quant-research");
  return {
    coverage: read<CoverageAudit>(path.join(dir, "coverage-audit.json")),
    mlbScan: read<CorrelationScan>(path.join(dir, "mlb-correlations.json")),
  };
}
