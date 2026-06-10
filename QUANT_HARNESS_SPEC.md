# Quant Research Harness — Spec ("Edge Lab")

Status: **design** (2026-06-03). Author intent: industrialize the exact gauntlet
that killed the favorite-longshot mirage today, so candidate edges are searched,
tested, and either deployed or killed — automatically, honestly, at scale.

## North-star principle (from the 2026 multi-agent-trading literature)

> **LLMs orchestrate and critique. Deterministic code is the only source of truth.**

Every numeric claim — win rate, EV, t-stat, Sharpe — comes from a tool, never
from a model. This is the "tool-grounding" finding (QuantAgent, TrustTrade):
binding LLMs to calculators + execution simulators is what reduces hallucination
and stops the model from rationalizing a t=1.43 result into an "edge."

The hard truth this harness is built around, proven today: the **backtest-to-live
gap** (spreads, fills, adverse selection) is what kills edges. The favorite-longshot
slice was +6.4% on paper and **0.0% after the adverse-selection fill simulation.**
So **fill realism is a first-class, non-negotiable gate**, not an afterthought.

## Build pattern

Pure Anthropic SDK code, mirroring the existing agent layer (`src/lib/agent/`):
`client.ts` MODELS map, structured tool contracts, fail-closed critic. **No
`.claude/agents/*.md` manifests. No Workflow tool.** Schedulers via GitHub Actions
(like `agent-dream.yml`). State in Turso via Prisma.

---

## Architecture

```
              ┌─────────────────────────────────────────────────────────┐
              │  orchestrator.ts  (weekly cron; the research loop)        │
              └─────────────────────────────────────────────────────────┘
   ┌──────────────┐   spec    ┌──────────────┐  verified  ┌──────────────┐
   │  Proposer    │──────────▶│  Tool layer  │──stats────▶│   Critic     │
   │  (Sonnet)    │           │ (deterministic│           │ (Sonnet/Opus)│
   │  emits N     │           │  ground truth)│           │ adversarial, │
   │  hypotheses  │◀──memory──│               │           │ fail-closed  │
   └──────────────┘           └──────────────┘            └──────┬───────┘
          ▲                                                       │ verdict
          │ killed-list                                           ▼
   ┌──────┴───────┐                                      ┌──────────────┐
   │ Synthesizer  │◀──────────── register results ───────│  HARD GATES  │
   │ (Opus, dream)│                                       │  G1–G6 (code)│
   └──────────────┘                                       └──────┬───────┘
                                                    survivors │
                                                              ▼
                                              size (Kelly) → deploy a sleeve
                                              of the $10k paper book, tagged
                                              by hypothesisId (forward proof)
```

### 1. Deterministic tool layer — `src/lib/quant/tools/` (≈80% built today)

| Tool | Purpose | Status |
|---|---|---|
| `universe.ts` | hypothesis spec → filtered Kalshi market set (reuses `marketData.ts`) | adapt from today |
| `backtest.ts` | calibration curve `f(p)`, realized win-rate, EV by bucket | **built** (`kalshi-flb-backtest.ts`) |
| `fillSim.ts` | **the critical tool** — taker/maker fill + adverse-selection from candle paths | **built** (`flb-adverse-selection.ts`) |
| `stats.ts` | Wilson CI, t-stat, **deflated Sharpe**, Bonferroni/Benjamini-Hochberg | partial (Wilson + t done) |
| `risk.ts` | fractional-Kelly sizing, risk-of-ruin Monte Carlo, drawdown dist | to build |

These are pure functions over cached scraped data (`flb-settled.json`,
`flb-priced.json`, candlesticks). No LLM in this layer.

### 2. LLM agent layer — `src/lib/quant/agents/`

- **Proposer (Sonnet)** — emits **structured, falsifiable** `HypothesisSpec`s
  (schema below). Seeded with: the four sharp-betting books' principles (EV,
  CLV, variance/resulting, portfolio risk) and a **memory of already-tested
  hypotheses** so it never re-proposes a killed one. It proposes the *idea*;
  it never computes the result.
- **Critic (Sonnet/Opus) — adversarial, fail-closed** (mirrors `critic.ts`).
  Its job is to **refute**, not confirm. Checks: under-powered n, t<2 on the
  *post-fill* number, OOS divergence, look-ahead/leakage, regime dependence,
  multiple-testing inflation, "is the assume-all-fill number being quoted
  instead of the realized-fill number?" If it cannot rule out noise → **REJECT**.
- **Synthesizer (Opus)** — weekly memory consolidation (mirrors `dream.ts`):
  records survivors, kills + reasons, and patterns ("longshot fades fail across
  all categories") into the hypothesis store.

### 3. Hard gates — `src/lib/quant/gates.ts` (the books, encoded as code)

A hypothesis advances to deployment **only if ALL pass** (deterministic, no LLM
discretion — this is what stops the rationalization failure mode):

| Gate | Rule | Why |
|---|---|---|
| **G1 Sample** | n ≥ 200 in the tested slice | power; Whelan/Duke small-sample warning |
| **G2 Significance** | t > 2 on the **realized (post-fill) EV** (lower Wilson bound > 0) | kills the 22-15 / t=1.43 trap |
| **G3 Out-of-sample** | later-window EV > 0 and within tolerance of earlier window | no in-sample fantasies (the +$487K trap) |
| **G4 Fill realism** | **adverse-selection sim**: realized-fill EV (not assume-all-fill) clears the bar | the gate that killed favorite-longshot |
| **G5 Multiple testing** | deflated Sharpe / corrected p across ALL hypotheses tried this run | penalize the search itself |
| **G6 Cost** | net of fees + modeled slippage | no paper-only edges |

### 4. The loop — `orchestrator.ts`

```
1. Proposer emits N hypotheses (pre-registered: logged BEFORE backtest)
2. For each: universe → backtest → fillSim → stats        (tools, deterministic)
3. Critic adversarially reviews each (fail-closed)         (LLM)
4. Gates G1–G6 applied                                     (code)
5. Survivors: risk.ts sizes them (¼-Kelly, capped) → deploy a sleeve of the
   $10k paper book tagged by hypothesisId (existing paper engine executes/tracks)
6. All outcomes (survive/kill + reason) → Synthesizer → hypothesis memory
```

Runs weekly (GitHub Actions). Survivors are forward-validated live in the paper
trail; the live record is the final, un-gameable proof.

---

## Data model (Prisma, extends today's tables)

```prisma
model QuantHypothesis {
  id           Int     @id @default(autoincrement())
  title        String
  rationale    String
  spec         String  // JSON HypothesisSpec
  proposedAt   String  // ISO (pre-registration timestamp)
  status       String  // proposed | backtested | killed | deployed | retired
  backtest     String? // JSON BacktestResult (stats, OOS, fillSim)
  criticVerdict String?
  killReason   String?
  gatesPassed  String? // JSON {G1..G6: bool}
  deployedAt   String?
}
// Deployment reuses KalshiPaperPosition / KalshiPaperLedgerSnapshot,
// adding `hypothesisId Int?` so each sleeve's live P&L is attributable.
```

## HypothesisSpec — the structured contract (Proposer → tools)

```ts
interface HypothesisSpec {
  id: string;
  title: string;
  rationale: string;                 // the book-grounded "why"
  universe: {
    categories?: string[];
    excludeCategories?: string[];    // e.g. ["Sports"]
    minVolume: number; minOpenInterest: number;
  };
  entry: {
    side: "yes" | "no";
    priceMin: number; priceMax: number;   // e.g. 0.80–0.95
    horizonHours: number;                 // entry timing pre-close
    maxSpread: number;
  };
  fillModel: "taker" | "maker_at_bid" | "maker_join_improve";
  prediction: {                       // the falsifiable claim
    metric: "win_rate" | "realized_ev";
    direction: ">" | "<";
    vs: "price" | "zero";
    threshold?: number;
  };
}
```

Falsifiable, unambiguous, no wiggle room for the LLM.

## File layout

```
src/lib/quant/
  tools/   universe.ts  backtest.ts  fillSim.ts  stats.ts  risk.ts
  agents/  proposer.ts  critic.ts  synthesizer.ts
  gates.ts  orchestrator.ts  client.ts(MODELS)  types.ts
scripts/   quant-research.ts            # run one cycle (cron + manual)
.github/workflows/ quant-research.yml   # weekly
prisma/    QuantHypothesis model (+ hypothesisId on paper tables)
```

## Anti-overfitting / honesty mechanisms (non-negotiable)

- **Pre-registration**: hypotheses logged before backtest; proposer cannot peek.
- **Adversarial critic** (refute, not confirm) + optional N-critic consensus
  (TrustTrade): reject if any critic flags a fatal issue.
- **Multiple-testing correction** across the whole search (G5).
- **Fill realism is a gate, not a footnote** (G4).
- **Forward validation**: gates qualify a hypothesis for *paper* deployment; only
  a live paper track record justifies real capital.

## Honest expectation (set before building)

Three rigorously-tested no-edges so far (sports analysis, latency arb,
favorite-longshot). This harness **industrializes the search and the honesty** —
its most likely output is *more confirmed no-edges, faster and cheaper*, which is
valuable (it stops bad deployments) but is **not a money printer**. The 2026
literature's own verdict: *"consistent alpha generation remains an open
challenge."* The harness changes how fast and how honestly you search; it cannot
make an efficient market inefficient.

## Build phases

1. **Tools** — generalize `backtest.ts` + `fillSim.ts` from today's scripts;
   finish `stats.ts` (deflated Sharpe, BH) + `risk.ts` (Kelly, ruin MC). *(No LLM.)*
2. **Gates + types + a manual driver** — run a hand-written `HypothesisSpec`
   end-to-end through tools+gates. Reproduce today's favorite-longshot KILL
   automatically as the first regression test.
3. **Agents** — proposer, adversarial critic, synthesizer + `QuantHypothesis`
   store. Pre-registration wired.
4. **Loop + deploy** — orchestrator; survivors deploy a sleeve of the paper book;
   weekly cron; dashboard panel for hypotheses (proposed / killed / deployed).

Phase 1–2 are the high-value core (the gauntlet, automated). Phases 3–4 add the
agentic search + memory on top.
```
