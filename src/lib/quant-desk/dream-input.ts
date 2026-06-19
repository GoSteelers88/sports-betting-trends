// quant-desk/dream-input.ts — the QUANT DESK's contribution to the weekly dream.
//
// The dream is the desk's learning brain: each week it reads the MLB quant
// ledger + CLV, the NFL dry-run report, the coverage-audit backlog, and the top
// discovered correlations, and reflects — is the desk getting CLV? what missing
// stat would help most? which discovered correlation is worth validating next?
//
// This module assembles that READ-ONLY payload (the `quantDesk` block) plus the
// durable doctrine. Best-effort: any missing/corrupt artifact degrades to a stub
// so the dream never fails on a side input. The dream REFLECTS on this; it never
// opens, settles, or mutates the desk.

import { getQuantDeskView, mlbBookDir, nflBookDir } from "./store";
import { computeStats, QUANT_DESK_CONFIG } from "./engine";
import { loadBook } from "./store";
import { loadResearchSummary } from "./research/research-runner";
import { QUANT_DESK_LEARNINGS } from "../agent/memory";

export interface QuantDeskDreamBlock {
  note: string;
  doctrine: Array<{ rule: string; weight: number }>;
  mlbLive: {
    equityUsd: number;
    realizedPnlUsd: number;
    roiPct: number;
    record: string;
    yieldPct: number | null;
    openCount: number;
    avgEdge: number | null;
    clvBeatRatePct: number | null;
    avgClvCents: number | null;
    clvSettledCount: number;
    drawdownPct: number;
    railActive: boolean;
  } | null;
  nflDryRun: {
    record: string;
    roiPct: number;
    avgEdge: number | null;
    clvBeatRatePct: number | null;
    avgClvCents: number | null;
    note: string;
  } | null;
  coverageBacklog: Array<{
    sport: string;
    market: string;
    status: string;
    impact: string;
    difficulty: string;
    priority: number;
  }>;
  topHypotheses: Array<{
    feature: string;
    target: string;
    r: number | null;
    pValue: number | null;
    n: number;
    validationPlan: string;
  }>;
  killCriterion: string;
}

/** Build the read-only `quantDesk` block for the dream payload. Never throws. */
export function readQuantDeskForDream(): QuantDeskDreamBlock {
  const doctrine = QUANT_DESK_LEARNINGS.map((l) => ({ rule: l.rule, weight: l.weight }));

  // MLB live book.
  let mlbLive: QuantDeskDreamBlock["mlbLive"] = null;
  try {
    const view = getQuantDeskView("MLB", mlbBookDir());
    const s = view.stats;
    mlbLive = {
      equityUsd: s.equityUsd,
      realizedPnlUsd: s.realizedPnlUsd,
      roiPct: s.roiPct,
      record: `${s.wins}-${s.losses}${s.pushes ? `-${s.pushes}` : ""}`,
      yieldPct: s.yieldPct,
      openCount: s.openCount,
      avgEdge: s.avgEdge,
      clvBeatRatePct: s.clvBeatRatePct,
      avgClvCents: s.avgClvCents,
      clvSettledCount: s.clvSettledCount,
      drawdownPct: s.drawdownPct,
      railActive: s.equityUsd < s.startingBankrollUsd * (1 - QUANT_DESK_CONFIG.maxDrawdown),
    };
  } catch {
    mlbLive = null;
  }

  // NFL dry-run book (private).
  let nflDryRun: QuantDeskDreamBlock["nflDryRun"] = null;
  try {
    const s = computeStats(loadBook(nflBookDir(), "NFL"), QUANT_DESK_CONFIG);
    if (s.settledCount > 0) {
      nflDryRun = {
        record: `${s.wins}-${s.losses}${s.pushes ? `-${s.pushes}` : ""}`,
        roiPct: s.roiPct,
        avgEdge: s.avgEdge,
        clvBeatRatePct: s.clvBeatRatePct,
        avgClvCents: s.avgClvCents,
        note: "DRY-RUN vs ~closing nflverse lines — ROI is an optimistic upper bound, CLV is ~0 by construction. Edge distribution is the signal, not P&L.",
      };
    }
  } catch {
    nflDryRun = null;
  }

  // Learning artifacts (coverage backlog + top discovered correlations).
  const { coverage, mlbScan } = loadResearchSummary();
  const coverageBacklog = (coverage?.backlog ?? [])
    .filter((b) => b.status !== "covered")
    .slice(0, 8)
    .map((b) => ({
      sport: b.sport,
      market: b.market,
      status: b.status,
      impact: b.impact,
      difficulty: b.difficulty,
      priority: b.priority,
    }));

  const topHypotheses = (mlbScan?.candidates ?? [])
    .slice(0, 5)
    .map((c) => ({
      feature: c.feature,
      target: c.target,
      r: c.target === "residual" ? c.rResidual : c.rOutcome,
      pValue: c.pValue,
      n: c.n,
      validationPlan: c.validationPlan,
    }));

  return {
    note:
      "THE QUANT DESK (Benter/Benham/Bloom): model the mispricings, bet only edge >= 3% with sharp-direction agreement, size 1/4-Kelly with a drawdown rail, judge by CLV. Reflect: is the desk getting CLV? what MISSING stat (coverage backlog) would add the most edge? which discovered correlation is worth validating next? Discovered correlations are HYPOTHESES — never promote one in-sample. Treat any sample with clvSettledCount < 50 as preliminary.",
    doctrine,
    mlbLive,
    nflDryRun,
    coverageBacklog,
    topHypotheses,
    killCriterion:
      "Kill/validate at n>=50 settled MLB plays: REAL only if CLV beat-rate >= 55% AND avg CLV >= +2c; else KILL. Win rate is not the metric.",
  };
}
