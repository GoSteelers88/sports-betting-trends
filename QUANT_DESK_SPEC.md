# THE QUANT DESK — model-edge betting (pre-registered)

In the doctrine of **Bill Benter** (Hong Kong horse-racing model), **Matthew
Benham** (Smartodds / Brentford — football xG models) and **Tony Bloom**
(Starlizard — the sharpest syndicate in football). The shared method:

> A **proprietary model** makes fair probabilities. You bet **only where the
> market is mispriced vs your model**. You **size fractional-Kelly** behind a
> drawdown rail. You **judge yourself by closing-line value (CLV)**, not wins.
> And a **data-science loop never stops learning** — auditing missing data and
> discovering new predictive correlations to strengthen the model.

This rule is **pre-registered**: the parameters below were fixed before the
first paper play. Tuning them after seeing results voids the test (start a new
numbered spec instead). The desk **places nothing real**.

## The rule (deterministic engine)

Per slate, per sport, four steps (`src/lib/quant-desk/engine.ts`):

| Step | What |
|---|---|
| 1. Fair-value bus | The adapter emits `FairValue[]` from OUR model (MLB: `mlb-model` win-prob + `mlb-prop-distributions` ladders; NFL: a transparent leak-safe Elo dry-run). |
| 2. Mispricing scan | `edge = modelFairProb − devigMarketProb`. PLAY only when `edge ≥ 3%` **AND** the model agrees-in-direction with the sharp line (take the sharp-favored side at a better price — never fade the sharp). `edge > 20%` is quarantined as a data artifact. |
| 3. Sizing | ¼-Kelly on the model fair prob · cap ≤ **2% of equity** per bet · **drawdown rail**: HALT all new opens while equity is ≥20% below the $10k start. |
| 4. Ledger + CLV | Accounting DERIVED from bet rows (cash can't drift). Each bet tracks the closing sharp fair; **CLV beat-rate + avg CLV is the HEADLINE.** |

One bet per `(sport, gameId, outcome)` — idempotent across re-runs. $10k paper
book per sport.

### Edge floor + sizing + drawdown rail — the numbers

| Parameter | Value |
|---|---|
| Edge floor | `modelFairProb − devigMarketProb ≥ 0.03` (3%) |
| Edge ceiling (artifact guard) | `> 0.20` quarantined, never bet |
| Direction gate | the bet side must be the sharp-favored side (`devigMarketProb > 0.5`) |
| Kelly | quarter-Kelly (`0.25`) on the model fair prob |
| Per-bet cap | `≤ 2%` of current equity |
| Drawdown rail | no opens while `equity < start · (1 − 0.20)` |
| Min stake | $10 |
| Starting bankroll | $10,000 (paper) |

## CLV-first kill / verdict criterion

CLV is the only metric with statistical power at the samples we have, and the
canonical proof a betting edge is real (the price you took beat the market's
converged estimate). **Win rate is noise** until N is large; we do not judge by it.

At **n ≥ 50 settled MLB plays**:

- CLV beat-rate **≥ 55%** AND avg CLV **≥ +2¢** → the edge is **real**; consider sizing up / placement.
- otherwise → **kill** (the model isn't beating the close).

## MLB-live vs NFL-dry-run

- **MLB is the live paper desk.** Real model (xERA→log5→Pythagorean, market-shrunk
  moneyline + the prop milestone distributions), real sharp (de-vigged Pinnacle)
  and soft (FanDuel/Bovada/Odds-API) feeds. Moneyline bets settle vs ESPN finals;
  prop bets are logged + CLV-tracked (a per-game box-score prop settler is a
  follow-up). On the dashboard as **FOL. 10**. CLI: `npm run quant:mlb` /
  `quant:mlb report`.
- **NFL is a QUIET, PRIVATE dry-run.** NFL has no tuned model here, so the fair
  value is a transparent, **leak-safe Elo power rating** (built only from games
  strictly before each week) — flagged `estimate` and labelled "dry-run". It runs
  as a backtest over the loop's cached weeks vs nflverse **~closing** lines. Because
  entry == close, **CLV ≈ 0 by construction** and any positive ROI is an
  **optimistic upper bound**. The dry-run's purpose is to prove the engine on real
  games and measure the model-vs-market **edge distribution** — never to ship NFL
  picks. NO dashboard, NO nav, NO user-facing NFL strings; state under
  `data/private/nfl-loop/quant/`. CLI: `npm run quant:nfl:dryrun`.

## The learning loop (the Starlizard / Smartodds data-science floor)

`src/lib/quant-desk/research/` — deterministic + honest, two modules:

1. **Missing-stat / coverage audit** (`coverage-audit.ts`). Programmatically
   inspects the ACTUAL feed schemas (the MLB gamelog's per-game stat keys; the
   NFL games.csv header) against the markets we WANT to price, and emits a ranked
   **DATA-ACQUISITION BACKLOG**. Each item: the stat, why it's missing (absent
   feed key vs synthesizable proxy), which market it would unlock, and an
   impact/difficulty estimate. Detected, not hardcoded — e.g. it surfaces that the
   MLB gamelog lacks 2B/3B/SB/batter-K/walks (so Total Bases is only a synthesized
   proxy and Stolen Bases / Batter Strikeouts can't be priced) and that NFL lacks
   weather/snap-level inputs.

2. **Correlation / feature discovery** (`correlations.ts`). Over the accumulated
   data (the NFL graded log + both quant books' settled bets), computes Pearson
   correlations between every available feature and (a) the OUTCOME and (b) the
   model's OWN RESIDUAL (`modelFairProb − outcome` — where the model is
   systematically wrong). Each candidate gets a two-sided significance test;
   the strongest significant ones surface as model-improvement **HYPOTHESES**.

### Quarantine + out-of-sample validation discipline (the López de Prado guard)

Discovered correlations are **HYPOTHESES, never auto-applied.** In-sample
correlation mining overfits — a feature that correlates with the residual on past
data is a lead, not a law. Each hypothesis is **logged with an explicit
out-of-sample validation plan** before it can be promoted into the model:

> Split the log chronologically. Refit/adjust on the EARLIER half only. Confirm
> the correlation holds (same sign, p < 0.05) — and improves CLV beat-rate — on
> the held-out LATER half. Promote only if it survives; **never apply the
> in-sample fit.**

The live rule (edge floor, sizing, direction gate) **never changes from in-sample
mining.** This is pre-registered here so a future "we found a great correlation"
can't quietly skip the holdout.

## Dreaming in tune with the quant

The weekly dream (`src/lib/agent/dream.ts`) is the desk's learning brain. It reads
a read-only `quantDesk` block (`src/lib/quant-desk/dream-input.ts`): the MLB
ledger + CLV, the NFL dry-run report, the coverage backlog, and the top discovered
correlations — and reflects: *is the desk getting CLV? what missing stat would
help most? which discovered correlation is worth validating next?* It may NOTE a
hypothesis as worth validating but must NEVER propose promoting one in-sample.

Durable, **non-retirable** doctrine rules (`QUANT_DESK_LEARNINGS` in
`src/lib/agent/memory.ts`, type `quant-desk-doctrine`) keep the analyst, critic,
and dream aligned: bet only model-vs-market mispricings ≥ floor; CLV is the
benchmark not W-L; ¼-Kelly + drawdown rail; never chase a result; discovered
correlations are hypotheses until out-of-sample validated; NFL quant is a quiet
dry-run. The dream's retire pass excludes this type (system-prompt constraint +
a defense-in-depth `notIn` WHERE clause).

## Honesty notes (accepted)

- **Model fair values are estimates**, not gospel — especially the synthesized
  Total Bases series and any thin-sample prop fit (flagged `estimate`).
- **nflverse lines are ~closing**, so the NFL dry-run's CLV ≈ 0 and its ROI is an
  optimistic upper bound — never read as a live edge.
- **Paper / dry-run only.** The desk places nothing real. MLB prop bets are
  logged + CLV-tracked but not yet settled vs box scores (moneyline is, vs ESPN).
- An **empty board is the correct, honest output** of an efficient market — most
  slates produce zero plays at a 3% floor with the direction gate.

## Operations

- Engine: `src/lib/quant-desk/` (types · engine = pure decisions · store = JSON
  I/O · adapters/{mlb,nfl} · {mlb,nfl}-runner = impure cycle/backtest).
- Learning: `src/lib/quant-desk/research/` (coverage-audit · correlations ·
  research-runner).
- Dashboard: `src/app/_components/QuantDesk.tsx` (FOL. 10) + nav entry 10.
- Runners: `npm run quant:mlb` · `quant:mlb report` · `quant:nfl:dryrun` (private).
- State: `data/processed/quant-desk-mlb-book.json` (live) ·
  `data/processed/quant-research/` (coverage + MLB correlations) ·
  `data/private/nfl-loop/quant/` (NFL dry-run book + private NFL correlations).
- Tests: `src/lib/__tests__/quant-desk*.test.ts` (Vitest).
