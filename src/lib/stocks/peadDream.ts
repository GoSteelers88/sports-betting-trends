/**
 * peadDream.ts — weekly research memo for the PEAD paper book (Exp No. 3).
 *
 * Dream-as-HYPOTHESIS-FACTORY, not behavior modifier: unlike the sports
 * pipeline's dream (which writes AgentMemory rules that steer the analyst),
 * this pass is quarantined by construction — it reads the accumulating rows,
 * computes cohort splits deterministically in code, and has Claude write a
 * memo with candidate pre-registrations for FUTURE experiments. It writes to
 * a memo file and Discord only; it cannot touch the frozen trading rule.
 */
import { prisma } from "@/lib/prisma";
import { getAnthropic, MODELS } from "@/lib/agent/client";
import { PEAD_CONFIG, meanTStat, killVerdict } from "@/lib/stocks/peadLogic";
import { revenueConfirmed } from "@/lib/stocks/peadWatchdog";

export interface DreamRow {
  status: string;
  surprisePct: number;
  excessRetPct: number | null;
  pnlUsd: number | null;
  annotation: string | null; // JSON: {artifactRisk, revenueConfirmed, note}
  revEstimate: number | null;
  revActual: number | null;
}

interface CohortStat {
  n: number;
  meanExcessPct: number | null;
  t: number | null;
}

export interface DreamStats {
  entries: {
    total: number;
    open: number;
    closed: number;
    avgSurprisePct: number | null;
    artifactRisk: { low: number; medium: number; high: number; unannotated: number };
    revenueConfirmed: { yes: number; no: number; unknown: number };
  };
  performance: {
    all: CohortStat;
    revenueConfirmedYes: CohortStat;
    revenueConfirmedNo: CohortStat;
    artifactLow: CohortStat;
    artifactMedHigh: CohortStat;
    surprise20to50: CohortStat;
    surprise50to100: CohortStat;
    surpriseOver100: CohortStat;
  };
  book: { realizedPnlUsd: number };
  verdict: { settled: number; needed: number; state: string };
}

function parseRisk(annotation: string | null): "low" | "medium" | "high" | null {
  if (!annotation) return null;
  try {
    const a = JSON.parse(annotation);
    return ["low", "medium", "high"].includes(a.artifactRisk) ? a.artifactRisk : null;
  } catch {
    return null;
  }
}

function rowRevenueConfirmed(r: DreamRow): boolean | null {
  // Prefer the annotation's stored value; fall back to the deterministic calc.
  if (r.annotation) {
    try {
      const a = JSON.parse(r.annotation);
      if (typeof a.revenueConfirmed === "boolean") return a.revenueConfirmed;
    } catch {
      /* fall through */
    }
  }
  return revenueConfirmed(r.revEstimate, r.revActual);
}

function cohort(rows: DreamRow[]): CohortStat {
  const excess = rows
    .map((r) => r.excessRetPct)
    .filter((x): x is number => x != null && Number.isFinite(x));
  const { n, mean, t } = meanTStat(excess);
  return { n, meanExcessPct: mean != null ? +mean.toFixed(2) : null, t: t != null ? +t.toFixed(2) : null };
}

/** Pure aggregation — all the math happens here, not in the LLM. */
export function computeDreamStats(rows: DreamRow[]): DreamStats {
  const open = rows.filter((r) => r.status === "open");
  const closed = rows.filter((r) => r.status === "closed");
  const risks = rows.map((r) => parseRisk(r.annotation));
  const revs = rows.map(rowRevenueConfirmed);

  const surprises = rows.map((r) => r.surprisePct).filter(Number.isFinite);
  const closedExcess = closed
    .map((r) => r.excessRetPct)
    .filter((x): x is number => x != null && Number.isFinite(x));

  return {
    entries: {
      total: rows.length,
      open: open.length,
      closed: closed.length,
      avgSurprisePct:
        surprises.length > 0 ? +(surprises.reduce((s, x) => s + x, 0) / surprises.length).toFixed(1) : null,
      artifactRisk: {
        low: risks.filter((r) => r === "low").length,
        medium: risks.filter((r) => r === "medium").length,
        high: risks.filter((r) => r === "high").length,
        unannotated: risks.filter((r) => r === null).length,
      },
      revenueConfirmed: {
        yes: revs.filter((r) => r === true).length,
        no: revs.filter((r) => r === false).length,
        unknown: revs.filter((r) => r === null).length,
      },
    },
    performance: {
      all: cohort(closed),
      revenueConfirmedYes: cohort(closed.filter((r) => rowRevenueConfirmed(r) === true)),
      revenueConfirmedNo: cohort(closed.filter((r) => rowRevenueConfirmed(r) === false)),
      artifactLow: cohort(closed.filter((r) => parseRisk(r.annotation) === "low")),
      artifactMedHigh: cohort(
        closed.filter((r) => ["medium", "high"].includes(parseRisk(r.annotation) ?? "")),
      ),
      surprise20to50: cohort(closed.filter((r) => r.surprisePct < 50)),
      surprise50to100: cohort(closed.filter((r) => r.surprisePct >= 50 && r.surprisePct < 100)),
      surpriseOver100: cohort(closed.filter((r) => r.surprisePct >= 100)),
    },
    book: {
      realizedPnlUsd: +closed.reduce((s, r) => s + (r.pnlUsd ?? 0), 0).toFixed(2),
    },
    verdict: {
      settled: closedExcess.length,
      needed: PEAD_CONFIG.killMinSettles,
      state: killVerdict(closedExcess),
    },
  };
}

const DREAM_SYSTEM = `You are the weekly research partner for Experiment No. 3 — a PRE-REGISTERED post-earnings-announcement-drift paper test (rule: long EPS beats >= +20%, $500 each, max 20 concurrent, 28-day hold, taker market orders on Alpaca paper, metric = excess return vs SPY; kill rule at n=40 settled: mean excess <= 0 kills, t >= 2 validates, else extend to n=80).

Write this week's research memo from the aggregates provided. Hard rules:
1. NEVER propose changing Experiment No. 3's parameters, universe, sizing, exit, or annotation rubric while it runs. The rule is frozen; tuning mid-flight voids the test. If a change seems tempting, it belongs in a FUTURE experiment.
2. Every quantitative claim must cite its n. Label every cohort below the n=40 kill threshold as preliminary/noise — interim splits are the garden of forking paths, observed but never acted on.
3. You may propose at most 3 candidate pre-registrations for future experiments (Exp 4+), each with exact parameters and its own kill rule, and only when the data or established literature genuinely motivates it. "None yet" is a respectable answer.
4. Data-quality observations (artifact-risk mix, revenue-leg coverage, thin weeks) are operational notes, not edges.

Format: markdown, under 600 words, exactly these sections: ## Status, ## Observations, ## Data quality, ## Candidate pre-registrations.`;

export type PeadDreamResult =
  | { skipped: "no-entries" }
  | { skipped: null; memo: string; stats: DreamStats };

export async function runPeadDream(): Promise<PeadDreamResult> {
  const rows = await prisma.stockPaperPosition.findMany({
    select: {
      status: true,
      surprisePct: true,
      excessRetPct: true,
      pnlUsd: true,
      annotation: true,
      revEstimate: true,
      revActual: true,
    },
  });
  if (rows.length === 0) return { skipped: "no-entries" };

  const stats = computeDreamStats(rows);
  const client = getAnthropic();
  const response = await client.messages.create({
    model: MODELS.dream,
    max_tokens: 2500,
    system: DREAM_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Memo date: ${new Date().toISOString().slice(0, 10)}\n\n` +
          `Aggregates (computed deterministically from the book of record):\n` +
          JSON.stringify(stats, null, 2),
      },
    ],
  });
  const memo = response.content
    .filter((b): b is { type: "text"; text: string } & typeof b => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { skipped: null, memo, stats };
}
