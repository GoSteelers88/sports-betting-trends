// Homegrown "outcomes" grader — runs locally in process, no extra LLM call.
// Each pick from the analyst is checked against a strict rubric. Picks that
// fail get tagged with `gradeFailures` so the API caller can decide whether to
// drop them. Hard failures (missing thesis, edge below threshold) always drop.

import type { AnalystPick } from "./analyst";

export type GradedPick = AnalystPick & {
  graderOk: boolean;
  graderNotes: string[];
};

const MIN_EDGE = 0.03; // 300 bps
const MAX_KELLY_UNITS = 2.0;
const MIN_THESIS_CHARS = 80;

export function gradePicks(picks: AnalystPick[]): GradedPick[] {
  const out: GradedPick[] = [];
  for (const p of picks) {
    const notes: string[] = [];

    // Hard checks
    if (!p.matchup) notes.push("HARD: missing matchup");
    if (!p.market) notes.push("HARD: missing market");
    if (!p.selection) notes.push("HARD: missing selection");
    if (typeof p.oddsAmerican !== "number") notes.push("HARD: oddsAmerican not numeric");
    if (typeof p.modelProb !== "number" || p.modelProb < 0.01 || p.modelProb > 0.99)
      notes.push("HARD: modelProb out of range");
    if (typeof p.marketProb !== "number" || p.marketProb < 0.01 || p.marketProb > 0.99)
      notes.push("HARD: marketProb out of range");

    // Recompute edge ourselves to catch math errors
    if (typeof p.modelProb === "number" && typeof p.marketProb === "number") {
      const computedEdge = p.modelProb - p.marketProb;
      if (Math.abs(computedEdge - p.edge) > 0.005) {
        notes.push(`SOFT: claimed edge ${p.edge.toFixed(4)} disagrees with computed ${computedEdge.toFixed(4)}`);
      }
      if (computedEdge < MIN_EDGE) {
        notes.push(`HARD: edge ${(computedEdge * 100).toFixed(2)}% below ${(MIN_EDGE * 100).toFixed(2)}% minimum`);
      }
    }

    // Stake sanity
    if (typeof p.kellyStakeUnits === "number") {
      if (p.kellyStakeUnits <= 0) notes.push("HARD: stake must be positive");
      if (p.kellyStakeUnits > MAX_KELLY_UNITS)
        notes.push(`SOFT: stake ${p.kellyStakeUnits} exceeds ${MAX_KELLY_UNITS}u cap (will be clamped on logging)`);
    } else {
      notes.push("HARD: kellyStakeUnits not numeric");
    }

    // Confidence
    if (typeof p.confidence !== "number" || p.confidence < 1 || p.confidence > 100)
      notes.push("HARD: confidence must be 1-100");

    // Required prose
    if (!p.thesis || p.thesis.length < MIN_THESIS_CHARS)
      notes.push(`HARD: thesis too short (${p.thesis?.length ?? 0} < ${MIN_THESIS_CHARS} chars)`);
    if (!p.invalidation || p.invalidation.length < 10)
      notes.push("HARD: invalidation must be at least one sentence");

    if (!Array.isArray(p.signals) || p.signals.length === 0)
      notes.push("SOFT: no signals listed");

    const hardFail = notes.some(n => n.startsWith("HARD:"));
    if (hardFail) continue; // drop entirely

    out.push({
      ...p,
      kellyStakeUnits: Math.min(p.kellyStakeUnits, MAX_KELLY_UNITS),
      graderOk: notes.length === 0,
      graderNotes: notes,
    });
  }
  return out;
}
