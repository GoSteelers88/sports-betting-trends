// Homegrown "outcomes" grader — runs locally in process, no extra LLM call.
// Each pick from the analyst is checked against a strict rubric. Picks that
// fail get tagged with `gradeFailures` so the API caller can decide whether to
// drop them. Hard failures (missing thesis, edge below threshold) always drop.

import type { AnalystPick } from "./analyst";

export type GradedPick = AnalystPick & {
  graderOk: boolean;
  graderNotes: string[];
};

// Each dropped pick is returned alongside `kept` picks so the orchestrator can
// telemetry-notify on silent drops (e.g., analyst stated 6.1% edge but the
// recompute gave 5.9% — pre-2026-05-20 this pick vanished without a Discord
// or AgentRun trace, masking what may be a calibration drift in the model.)
export type GraderDrop = {
  pick: AnalystPick;
  notes: string[];
};

export type GradeResult = {
  kept: GradedPick[];
  dropped: GraderDrop[];
};

// Minimum pre-vig edge required to keep a pick. Bumped from 3% → 6% to clear
// market vig (Pinnacle ~2%, soft books 4-5%) plus a margin of safety for
// model error. CLV-validated research: edges below the vig are net-negative
// even when the model is right; the floor needs to leave room for the juice.
const MIN_EDGE = 0.06; // 600 bps
// Tolerance band below the floor. If the analyst's claimed edge passes the
// floor but the recompute lands within `[MIN_EDGE - EDGE_TOLERANCE, MIN_EDGE)`
// — i.e., off by <0.5pp due to rounding — we keep the pick at half stake
// with a graderNotes warning, rather than silently dropping it. Below the
// tolerance band it's a real model/math error and we hard-fail.
const EDGE_TOLERANCE = 0.005; // 50 bps
const EDGE_TOLERANCE_STAKE_MULT = 0.5;
const MAX_KELLY_UNITS = 2.0;
const MIN_THESIS_CHARS = 80;

// Legacy entry point kept for callers that don't need the dropped-pick
// telemetry. New callers (orchestrator) should use gradePicksWithDrops to
// also surface what was rejected and why.
export function gradePicks(picks: AnalystPick[]): GradedPick[] {
  return gradePicksWithDrops(picks).kept;
}

export function gradePicksWithDrops(picks: AnalystPick[]): GradeResult {
  const kept: GradedPick[] = [];
  const dropped: GraderDrop[] = [];
  for (const p of picks) {
    const notes: string[] = [];
    let edgeToleranceTriggered = false;

    // Hard checks
    if (!p.matchup) notes.push("HARD: missing matchup");
    if (!p.market) notes.push("HARD: missing market");
    if (!p.selection) notes.push("HARD: missing selection");
    if (typeof p.oddsAmerican !== "number") notes.push("HARD: oddsAmerican not numeric");
    if (typeof p.modelProb !== "number" || !Number.isFinite(p.modelProb) || p.modelProb < 0.01 || p.modelProb > 0.99)
      notes.push("HARD: modelProb out of range");
    if (typeof p.marketProb !== "number" || !Number.isFinite(p.marketProb) || p.marketProb < 0.01 || p.marketProb > 0.99)
      notes.push("HARD: marketProb out of range");

    // Recompute edge ourselves to catch math errors
    if (typeof p.modelProb === "number" && typeof p.marketProb === "number") {
      const computedEdge = p.modelProb - p.marketProb;
      if (Math.abs(computedEdge - p.edge) > EDGE_TOLERANCE) {
        notes.push(`SOFT: claimed edge ${p.edge.toFixed(4)} disagrees with computed ${computedEdge.toFixed(4)}`);
      }
      if (computedEdge < MIN_EDGE) {
        const claimedPassed = p.edge >= MIN_EDGE;
        const withinTolerance = computedEdge >= MIN_EDGE - EDGE_TOLERANCE;
        if (claimedPassed && withinTolerance) {
          // Analyst rounded up; recompute lands in the tolerance band. Keep
          // at half stake with an explicit warning rather than silently
          // dropping. This avoids the "stated 6.1%, recomputed 5.9% → vanished"
          // pathology.
          notes.push(
            `SOFT: computed edge ${(computedEdge * 100).toFixed(2)}% landed in tolerance band [${((MIN_EDGE - EDGE_TOLERANCE) * 100).toFixed(2)}%, ${(MIN_EDGE * 100).toFixed(2)}%) — keeping at ${EDGE_TOLERANCE_STAKE_MULT}× stake`
          );
          edgeToleranceTriggered = true;
        } else {
          notes.push(`HARD: edge ${(computedEdge * 100).toFixed(2)}% below ${(MIN_EDGE * 100).toFixed(2)}% minimum`);
        }
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

    // Prop picks need the four structured fields so the autograder can
    // resolve them against ESPN box scores. The analyst prompt requires
    // these but the grader is the enforcement layer — refuse to ship a
    // prop pick that can't be auto-graded.
    if (p.market === "prop") {
      if (!p.player) notes.push("HARD: prop pick missing player");
      if (!p.propType) notes.push("HARD: prop pick missing propType");
      if (typeof p.line !== "number" || !Number.isFinite(p.line))
        notes.push("HARD: prop pick missing or non-numeric line");
      if (p.side !== "over" && p.side !== "under")
        notes.push(`HARD: prop pick side must be "over" or "under", got ${JSON.stringify(p.side)}`);
    }

    const hardFail = notes.some(n => n.startsWith("HARD:"));
    if (hardFail) {
      dropped.push({ pick: p, notes });
      continue;
    }

    let stake = Math.min(p.kellyStakeUnits, MAX_KELLY_UNITS);
    if (edgeToleranceTriggered) {
      stake = +(stake * EDGE_TOLERANCE_STAKE_MULT).toFixed(2);
    }

    kept.push({
      ...p,
      kellyStakeUnits: stake,
      graderOk: notes.length === 0,
      graderNotes: notes,
    });
  }
  return { kept, dropped };
}
