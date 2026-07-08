/**
 * parlayDream.ts — weekly research memo for the parlay paper book (Exp No. 4).
 *
 * Dream-as-HYPOTHESIS-FACTORY, not behavior modifier (same contract as
 * peadDream): it reads the accumulating parlay rows, computes cohort splits
 * deterministically in code, and has Claude write a memo with candidate
 * pre-registrations for FUTURE experiments. It writes to a memo file + Discord
 * only; it CANNOT touch the frozen Exp No. 4 rule. Quarantined by construction.
 */
import { getAnthropic, MODELS } from "@/lib/agent/client";
import {
  loadBook,
  computeStats,
  PARLAY_PAPER_CONFIG,
  type ParlayPaperBook,
  type ParlayBet,
} from "@/lib/parlay-paper";

// n threshold at which the spec's verdict can first be evaluated.
export const PARLAY_KILL_MIN_SETTLES = 30;

interface CohortStat {
  n: number;
  yieldPct: number | null; // realized P&L ÷ staked, %
  hitRatePct: number | null; // won ÷ (won+lost)
  evImpliedHitPct: number | null; // mean parlayFairProb over the cohort
}

export interface ParlayDreamStats {
  parlays: {
    total: number;
    open: number;
    settled: number;
    avgParlayEvPct: number | null;
    avgFlipDeltaPct: number | null;
    legVoidRate: number | null; // fraction of legs across settled parlays that pushed/voided
  };
  performance: {
    all: CohortStat;
    ev3to6: CohortStat; // by parlay EV at open
    ev6to12: CohortStat;
    evOver12: CohortStat;
    mlbOnly: CohortStat; // all 3 legs MLB
    mixed: CohortStat; // legs span leagues
  };
  book: { realizedPnlUsd: number; equityUsd: number };
  verdict: { settled: number; needed: number; state: string };
}

// Decisive = won/lost (full-void refunds don't count toward the verdict).
function decisive(parlays: ParlayBet[]): ParlayBet[] {
  return parlays.filter((p) => p.status === "won" || p.status === "lost");
}

function cohort(parlays: ParlayBet[]): CohortStat {
  const dec = decisive(parlays);
  const staked = dec.reduce((s, p) => s + p.stakeUsd, 0);
  const pnl = dec.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const won = dec.filter((p) => p.status === "won").length;
  const fairs = dec.map((p) => p.parlayFairProb).filter(Number.isFinite);
  return {
    n: dec.length,
    yieldPct: staked > 0 ? +((pnl / staked) * 100).toFixed(2) : null,
    hitRatePct: dec.length > 0 ? +((won / dec.length) * 100).toFixed(1) : null,
    evImpliedHitPct:
      fairs.length > 0 ? +((fairs.reduce((s, x) => s + x, 0) / fairs.length) * 100).toFixed(1) : null,
  };
}

function allMlb(p: ParlayBet): boolean {
  return p.legs.every((l) => l.league === "MLB");
}

/** Pure aggregation — all the math happens here, not in the LLM. */
export function computeParlayDreamStats(book: ParlayPaperBook): ParlayDreamStats {
  const all = book.parlays;
  const open = all.filter((p) => p.status === "open");
  const settled = all.filter((p) => p.status !== "open");
  const stats = computeStats(book);

  const evVals = all.map((p) => p.parlayEV).filter(Number.isFinite);
  const flipVals = all.map((p) => p.flipDelta).filter(Number.isFinite);

  // leg void rate across settled parlays
  const settledLegs = settled.flatMap((p) => p.legs);
  const voidedLegs = settledLegs.filter((l) => l.status === "void" || l.status === "push");

  const byEv = (lo: number, hi: number) =>
    cohort(settled.filter((p) => p.parlayEV >= lo && p.parlayEV < hi));

  const dec = decisive(settled);

  return {
    parlays: {
      total: all.length,
      open: open.length,
      settled: settled.length,
      avgParlayEvPct:
        evVals.length > 0 ? +((evVals.reduce((s, x) => s + x, 0) / evVals.length) * 100).toFixed(2) : null,
      avgFlipDeltaPct:
        flipVals.length > 0
          ? +((flipVals.reduce((s, x) => s + x, 0) / flipVals.length) * 100).toFixed(2)
          : null,
      legVoidRate:
        settledLegs.length > 0 ? +(voidedLegs.length / settledLegs.length).toFixed(3) : null,
    },
    performance: {
      all: cohort(settled),
      ev3to6: byEv(0.03, 0.06),
      ev6to12: byEv(0.06, 0.12),
      evOver12: byEv(0.12, Infinity),
      mlbOnly: cohort(settled.filter(allMlb)),
      mixed: cohort(settled.filter((p) => !allMlb(p))),
    },
    book: { realizedPnlUsd: stats.realizedPnlUsd, equityUsd: stats.equityUsd },
    verdict: {
      settled: dec.length,
      needed: PARLAY_KILL_MIN_SETTLES,
      state: parlayVerdict(dec),
    },
  };
}

/** Pure verdict per PARLAY_PAPER_SPEC.md — yield-based, never tunes the rule. */
export function parlayVerdict(decisiveSettled: ParlayBet[]): string {
  if (decisiveSettled.length < PARLAY_KILL_MIN_SETTLES) {
    return `accumulating (${decisiveSettled.length}/${PARLAY_KILL_MIN_SETTLES})`;
  }
  const staked = decisiveSettled.reduce((s, p) => s + p.stakeUsd, 0);
  const pnl = decisiveSettled.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const yieldPct = staked > 0 ? (pnl / staked) * 100 : 0;
  if (yieldPct <= 0) return "KILL (yield ≤ 0 at n≥30)";
  if (decisiveSettled.length < 60) return "continue to n=60 (yield > 0)";
  return "evaluate at n=60 (yield > 0; check hit-rate vs EV-implied)";
}

const DREAM_SYSTEM = `You are the weekly research partner for Experiment No. 4b — a PRE-REGISTERED parlay paper book (4a's exactly-3-leg rule never assembled a ticket in 17 daily cycles and was superseded 2026-07-05 on a clean book; see PARLAY_PAPER_SPEC.md). The frozen rule: assemble 2-3 leg parlays from props-board legs that are each +EV (>= 3% vs the de-vigged sharp prop line), one leg per DISTINCT game, blocking correlated legs; every valid 2- and 3-leg combo is enumerated, ranked by parlay EV, and taken greedily disjoint (a +EV third leg always out-EVs its own 2-leg subset, so 3-leg tickets form when the slate supports them, 2-leg otherwise); open only when parlay EV = Π(p_i·dec_i)-1 > 0 AND it survives a -4pt-per-leg fairProb haircut; stake = quarter-Kelly on the COMBINED prob/odds; $10k book; kill at n>=30 settled if yield <= 0, else continue to n=60. Metric = realized YIELD (P&L / staked), not win rate (most parlays lose by design). The 2-leg vs 3-leg yield split is observational only, never a gate.

This rule is built on lessons we already proved out — keep the memo anchored to them:
- +EV legs only: stacking legs that are merely 'likely' (not +EV vs the de-vigged sharp) loses; the parlay multiplies a negative per-leg edge.
- Favorites, not longshots: plus-money longshot stacks were a lottery (≈1-29, ≈−18% to −90% EV); short-favorite stacks across distinct games got near break-even (≈14.6% win vs 15.1% expected, ≈−2.4%) — the residual gap is the vig, closeable only with real +EV.
- DISTINCT, uncorrelated games: same-game/SGP correlation tax exceeds 20% hold, so correlated legs are structurally −EV; the rule's distinct-gameId + correlation block enforces this.
- Estimation error compounds: a 4–6pt per-leg overestimate flips a 3-leg parlay from +EV to a loss — hence the −4pt haircut gate and quarter-Kelly sizing.
These are the established priors. Read the live aggregates as evidence FOR or AGAINST them; don't re-derive them as if new.

Write this week's research memo from the aggregates provided. Hard rules:
1. NEVER propose changing Experiment No. 4b's parameters (leg EV floor, 2-3 legs, distinct-game rule, correlation block, haircut, Kelly fraction, caps, kill threshold) while it runs. The rule is frozen; tuning mid-flight voids the test. Tempting changes belong in a FUTURE experiment.
2. Every quantitative claim must cite its n. Label every cohort below the n=30 kill threshold as preliminary/noise — interim EV-band and league splits are the garden of forking paths, observed but never acted on.
3. You may propose at most 3 candidate pre-registrations for future experiments (Exp 5+), each with exact parameters and its own kill rule, and only when the data or established literature genuinely motivates it (e.g. 2-leg vs 3-leg, correlated-by-design SGPs as a SEPARATE hypothesis, an independence-stress test). "None yet" is a respectable answer.
4. Data-quality observations (leg void rate, flip-δ distribution, thin slates, missing-gameId legs) are operational notes, not edges.

Format: markdown, under 600 words, exactly these sections: ## Status, ## Observations, ## Data quality, ## Candidate pre-registrations.`;

export type ParlayDreamResult =
  | { skipped: "no-parlays" }
  | { skipped: null; memo: string; stats: ParlayDreamStats };

export async function runParlayDream(
  dir?: string,
): Promise<ParlayDreamResult> {
  const book = loadBook(dir ?? `${process.cwd()}/data/processed`);
  if (book.parlays.length === 0) return { skipped: "no-parlays" };

  const stats = computeParlayDreamStats(book);
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
          `Frozen config: ${JSON.stringify(PARLAY_PAPER_CONFIG)}\n\n` +
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
