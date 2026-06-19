import { prisma } from "@/lib/prisma";

export type ActiveMemory = {
  id: number;
  type: string;
  scope: string;
  rule: string;
  reasoning: string;
  weight: number;
};

export type RecentRecord = {
  windowDays: number;
  total: number;
  wins: number;
  losses: number;
  pushes: number;
  pnlUnits: number;
  roi: number | null;
};

// Pull the agent's record over the last N days (default 7) so the analyst's
// system prompt can include it. Helps the model self-calibrate: a cold streak
// should make it more conservative; a hot streak should not embolden it.
export async function getRecentRecord(
  league: string,
  windowDays = 7
): Promise<RecentRecord> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rec: RecentRecord = {
    windowDays,
    total: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    pnlUnits: 0,
    roi: null,
  };
  let totalStake = 0;
  try {
    const outcomes = await prisma.agentOutcome.findMany({
      where: {
        gradedAt: { gte: since },
        result: { in: ["win", "loss", "push"] },
        pick: { league },
      },
      include: { pick: true },
    });
    for (const o of outcomes) {
      rec.total++;
      if (o.result === "win") rec.wins++;
      else if (o.result === "loss") rec.losses++;
      else if (o.result === "push") rec.pushes++;
      rec.pnlUnits += o.unitsPnl ?? 0;
      totalStake += o.pick.kellyStakeUnits;
    }
    if (totalStake > 0) rec.roi = rec.pnlUnits / totalStake;
    rec.pnlUnits = +rec.pnlUnits.toFixed(2);
  } catch {
    // Best-effort — analyst still works without record data
  }
  return rec;
}

export function formatRecordForPrompt(rec: RecentRecord): string {
  if (rec.total === 0) {
    return `(no graded picks in last ${rec.windowDays} days — small-sample mode, be extra conservative)`;
  }
  const decided = rec.wins + rec.losses;
  const winRate = decided > 0 ? `${((rec.wins / decided) * 100).toFixed(1)}%` : "—";
  const roi = rec.roi !== null ? `${(rec.roi * 100).toFixed(1)}%` : "—";
  return `Last ${rec.windowDays} days: ${rec.wins}-${rec.losses}${rec.pushes ? `-${rec.pushes}` : ""} (${winRate} win rate, ${rec.pnlUnits >= 0 ? "+" : ""}${rec.pnlUnits.toFixed(2)}u, ROI ${roi}). Use this honestly: a cold streak means tighten edge requirements; a hot streak does NOT mean loosen them.`;
}

export async function getActiveMemoriesForScope(scope: string): Promise<ActiveMemory[]> {
  const rows = await prisma.agentMemory.findMany({
    where: { active: true, scope: { in: [scope, "ALL"] } },
    orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
    take: 50,
  });
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    scope: r.scope,
    rule: r.rule,
    reasoning: r.reasoning,
    weight: r.weight,
  }));
}

export function formatMemoriesForPrompt(memories: ActiveMemory[]): string {
  if (memories.length === 0) {
    return "(no learned rules yet — first run)";
  }
  return memories
    .map(
      m =>
        `- id=${m.id} · ${m.type} · ${m.scope} · weight ${m.weight.toFixed(2)}\n  rule: ${m.rule}\n  reasoning: ${m.reasoning}`
    )
    .join("\n");
}

// Latest completed dream's free-form notes — gives the analyst the human-style
// summary of what the consolidator concluded last week, not just the distilled
// rule rows.
export type LatestDreamSummary = {
  startedAt: string;
  picksReviewed: number;
  memoriesAdded: number;
  memoriesRetired: number;
  notes: string | null;
} | null;

export async function getLatestDreamSummary(): Promise<LatestDreamSummary> {
  const dream = await prisma.agentDreamRun.findFirst({
    where: { status: "completed" },
    orderBy: { startedAt: "desc" },
  });
  if (!dream) return null;
  return {
    startedAt: dream.startedAt.toISOString(),
    picksReviewed: dream.picksReviewed,
    memoriesAdded: dream.memoriesAdded,
    memoriesRetired: dream.memoriesRetired,
    notes: dream.notes,
  };
}

// Recent results grouped by team for the analyst's per-team self-awareness.
// Aggregate league record alone wasn't enough signal for the LLM to notice
// the per-team pattern (e.g. Pistons -174 then -184 on consecutive slates,
// both losses) — this surfaces the team trail explicitly.
export type TeamRecentRecord = {
  team: string;
  picks: Array<{
    pickId: number;
    selection: string;
    oddsAmerican: number;
    edge: number;
    gameDate: string;
    result: string;
  }>;
};

export async function getRecentResultsByTeam(
  league: string,
  windowDays = 14
): Promise<TeamRecentRecord[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const picks = await prisma.agentPick.findMany({
    where: {
      league,
      gameDate: { gte: since },
      market: "moneyline",
    },
    include: { outcome: true },
    orderBy: { gameDate: "desc" },
  });
  const byTeam = new Map<string, TeamRecentRecord["picks"]>();
  for (const p of picks) {
    if (!p.outcome) continue;
    const list = byTeam.get(p.selection) ?? [];
    list.push({
      pickId: p.id,
      selection: p.selection,
      oddsAmerican: p.oddsAmerican,
      edge: p.edge,
      gameDate: p.gameDate.toISOString().slice(0, 10),
      result: p.outcome.result,
    });
    byTeam.set(p.selection, list);
  }
  // Only surface teams with ≥2 graded picks — singletons don't signal a pattern.
  return [...byTeam.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([team, list]) => ({ team, picks: list }));
}

export function formatTeamRecordsForPrompt(records: TeamRecentRecord[]): string {
  if (records.length === 0) {
    return "(no team has ≥2 graded picks in the window — no per-team patterns to flag)";
  }
  return records
    .map(r => {
      const wins = r.picks.filter(p => p.result === "win").length;
      const losses = r.picks.filter(p => p.result === "loss").length;
      const trail = r.picks
        .slice(0, 5)
        .map(p => `${p.gameDate} ${p.oddsAmerican > 0 ? "+" : ""}${p.oddsAmerican} → ${p.result}`)
        .join(", ");
      return `- ${r.team}: ${wins}-${losses}  [${trail}]`;
    })
    .join("\n");
}

// ─── Durable parlay learnings (validated, not dream-derived) ────────────────
//
// These are the findings we proved out across the parlay/master-parlay paper
// experiments and backtests. Unlike the weekly dream's rules — which are
// induced from a rolling 30-day pick window and can be retired when the data
// shifts — these are stable conclusions about parlay construction that should
// persist. They're seeded once into AgentMemory as HARD GUARDRAILS
// (weight ≥ 0.5, scope ALL) so the analyst sees them in the same MEMORY RULES
// block as everything else and the critic enforces them.
//
// `type: "parlay-learning"` tags them so the dream's retire pass leaves them
// alone (the dream only retires rules its own window contradicts; these aren't
// in scope for that). The seed is idempotent: a learning is only inserted if no
// ACTIVE row with the same rule text already exists.

export const PARLAY_LEARNING_TYPE = "parlay-learning";

export type ParlayLearningSeed = {
  rule: string;
  reasoning: string;
  weight: number;
};

export const PARLAY_LEARNINGS: ParlayLearningSeed[] = [
  {
    rule: "Parlays: only stack legs that individually beat the de-vigged sharp line by ≥3% (the live Exp 4 +EV floor). Legs that are merely 'likely' to hit, but not +EV vs the sharp, lose over time — the parlay multiplies their negative edge.",
    reasoning:
      "Exp 4 (the parlay paper book) opens a parlay only when every leg is independently playable (EV ≥ 3% vs the de-vigged sharp prop line) AND the combined parlay EV = Π(p_i·dec_i)−1 is still positive after a −4pt-per-leg haircut. The whole thesis is that the product of independent +EV legs is +EV; legs picked on 'likelihood' rather than sharp-validated edge break that and the parlay inherits the vig.",
    weight: 0.7,
  },
  {
    rule: "Parlay favorites, not longshots. Stacking plus-money prop longshots was a lottery (≈1-29, roughly −18% to −90% EV). Stacking short favorites across distinct games got close to break-even (≈14.6% observed win vs 15.1% expected, ≈−2.4%). The remaining gap to profit is the vig — close it ONLY with genuinely +EV legs, never by reaching for longer prices.",
    reasoning:
      "Backtest of two parlay constructions: plus-money longshot stacks cratered (the multiplied tail risk swamps any edge and the books' longshot vig is brutal), while short-favorite stacks across distinct games converged near break-even. Neither is profitable without a real per-leg +EV edge — favorites just lose slower. The lesson is to build from favorites and let sharp-validated +EV (not price-chasing) supply the margin.",
    weight: 0.6,
  },
  {
    rule: "Parlay legs MUST come from DISTINCT games and be uncorrelated. Same-game / same-game-parlay (SGP) correlation tax exceeds 20% hold — the book prices correlation against you, so combining correlated legs is structurally −EV even when each leg looks +EV standalone.",
    reasoning:
      "The independence assumption (parlay fair prob = Π fairProb_i) only holds for uncorrelated legs. SGPs and same-team/same-player stacks are positively correlated, so the true joint prob is far below the product, while the book still bakes a >20% hold into the SGP price. Exp 4 enforces distinct gameIds plus a correlation block (same player, same team, pitcher-vs-opposing-batter) for exactly this reason.",
    weight: 0.7,
  },
  {
    rule: "Estimation error CUBES in a 3-leg parlay. A 4–6 point per-leg overestimate of each leg's true probability flips a +EV parlay into a loss. Size parlays small (quarter-Kelly on the COMBINED prob/odds, never the product of per-leg Kelly) and require the parlay to survive a per-leg fairProb haircut before opening.",
    reasoning:
      "Because the parlay multiplies per-leg probabilities, a small bias in each leg compounds: a −4 to −6pt error per leg on a 3-leg parlay is enough to turn the modeled +EV negative. Exp 4 guards this with the −4pt-per-leg haircut gate (open only if the parlay is still +EV after shaving every leg) and quarter-Kelly sizing on the combined prob/odds, which caps the downside when the estimates are optimistic.",
    weight: 0.6,
  },
];

/**
 * Idempotently seed the durable parlay learnings into AgentMemory. Safe to run
 * repeatedly (e.g. on deploy or via a script): a learning is inserted only if
 * no ACTIVE AgentMemory row already carries its exact rule text. Returns the
 * count actually inserted vs already-present.
 */
export async function seedParlayLearnings(): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const learning of PARLAY_LEARNINGS) {
    const existing = await prisma.agentMemory.findFirst({
      where: { active: true, rule: learning.rule },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.agentMemory.create({
      data: {
        type: PARLAY_LEARNING_TYPE,
        scope: "ALL",
        rule: learning.rule,
        reasoning: learning.reasoning,
        weight: learning.weight,
        evidence: JSON.stringify({ source: "parlay/master-parlay experiments + backtests" }),
        active: true,
      },
    });
    inserted++;
  }
  return { inserted, skipped };
}

// ─── Durable QUANT DESK doctrine (Benter / Benham / Bloom) ──────────────────
//
// THE QUANT DESK's operating doctrine, seeded as non-retirable guardrails (same
// mechanism as the parlay learnings). These are STABLE conclusions about how the
// desk operates — not window-induced rules — so the weekly dream must not retire
// them. They keep the analyst + critic + dream aligned on the model-edge method.

export const QUANT_DESK_LEARNING_TYPE = "quant-desk-doctrine";

export const QUANT_DESK_LEARNINGS: ParlayLearningSeed[] = [
  {
    rule: "Bet ONLY model-vs-market mispricings: a play needs edge = modelFairProb − devigMarketProb >= 3% AND the model must agree-in-direction with the sharp line (take the sharp-favored side at a better price; never fade the sharp). An empty board is the correct, honest output of an efficient market.",
    reasoning:
      "THE QUANT DESK's core thesis (Benter/Benham/Bloom): a proprietary model makes fair probabilities and we bet only where the market is mispriced vs the model. The direction-agreement gate is the Miller-Davidow retail edge - buy a better price on the sharp's own favored side rather than out-guessing the sharp. Edges above ~20% are quarantined as data artifacts, not bet.",
    weight: 0.8,
  },
  {
    rule: "CLV is the benchmark, not W-L. Judge THE QUANT DESK by closing-line-value beat-rate and average CLV, never by short-run wins. Kill/validate at n>=50: real only if CLV beat-rate >=55% AND avg CLV >= +2c; otherwise kill. Win rate is noise at the samples we have.",
    reasoning:
      "Closing-line value is the only metric with statistical power at small samples and the canonical proof a betting edge is real (the price you took beat the market's converged estimate). Wins/losses are dominated by variance until N is large; CLV is the pre-registered kill criterion in QUANT_DESK_SPEC.md.",
    weight: 0.8,
  },
  {
    rule: "Size quarter-Kelly on the model fair prob, cap any single bet at ~2% of the book, and HALT all new opens when equity is >=20% below the starting bankroll (the drawdown rail). Never chase a result - a losing run tightens, it never loosens, the staking.",
    reasoning:
      "Fractional Kelly is the conservative model-bet standard; the per-bet cap and drawdown rail are the risk doctrine that keeps an over-optimistic model from ruin. The rail is enforced in code (openFromOpportunities returns early when drawdownBreached). Chasing is the classic way a +EV edge still goes bust.",
    weight: 0.7,
  },
  {
    rule: "Discovered correlations are HYPOTHESES until out-of-sample validated. The learning loop mines correlations between features and outcomes/residuals, but mined-in-sample rules NEVER change the live model. Each hypothesis must pass a chronological holdout (refit on the earlier half, confirm same-sign significance on the held-out later half) before promotion. This is the Lopez de Prado overfitting guard.",
    reasoning:
      "In-sample correlation mining overfits - a feature that correlates with the model residual on past data is a lead, not a law. The quarantine + out-of-sample validation plan (logged per hypothesis in correlations.ts) is what separates a real predictor from a backtest mirage. The desk's live edge floor and sizing are fixed; only validated hypotheses ever move the model.",
    weight: 0.7,
  },
  {
    rule: "The NFL quant is a QUIET DRY-RUN, not a live desk. NFL has no tuned model, so its fair value is a transparent leak-safe Elo power rating, and nflverse lines are ~closing (entry==close so CLV ~0 by construction). Treat any positive NFL ROI as an optimistic upper bound; the dry-run's purpose is to prove the engine on real games and measure the model-vs-market edge distribution, never to ship NFL picks.",
    reasoning:
      "MLB is the live paper desk (real model, real sharp/soft feeds); NFL is a private dry-run measured against ~closing nflverse lines, which mechanically suppresses CLV and inflates ROI vs what a live entry would capture. Keeping the distinction explicit prevents the dry-run's flattering numbers from being mistaken for a live edge.",
    weight: 0.7,
  },
];

/**
 * Idempotently seed the durable quant-desk doctrine into AgentMemory. Same
 * mechanism + idempotency as seedParlayLearnings - these rows carry the
 * non-retirable QUANT_DESK_LEARNING_TYPE so the dream's retire pass leaves them
 * alone.
 */
export async function seedQuantDeskLearnings(): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const learning of QUANT_DESK_LEARNINGS) {
    const existing = await prisma.agentMemory.findFirst({
      where: { active: true, rule: learning.rule },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.agentMemory.create({
      data: {
        type: QUANT_DESK_LEARNING_TYPE,
        scope: "ALL",
        rule: learning.rule,
        reasoning: learning.reasoning,
        weight: learning.weight,
        evidence: JSON.stringify({ source: "THE QUANT DESK doctrine - Benter/Benham/Bloom; QUANT_DESK_SPEC.md" }),
        active: true,
      },
    });
    inserted++;
  }
  return { inserted, skipped };
}
