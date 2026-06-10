# Experiment No. 1 — Kalshi favorite-longshot paper book (verdict pre-registration)

**Registered 2026-06-10**, with 26 settled / 50 open positions on the book.
The entry rule has been fixed since launch (see `PAPER_CONFIG` in
`src/lib/kalshi/paperEngine.ts`); this document freezes the **verdict
criteria**, which the experiment previously lacked. Parameters below were
fixed before the verdict sample accumulated — tuning either the rule or
these criteria mid-flight voids the test.

## Background

The 23,382-market backtest (`scripts/kalshi-flb-backtest.ts` +
`flb-adverse-selection.ts`) killed the favorite-longshot maker edge in the
**broad** universe: 73.6% real fill rate, filled favorites won 85.4% vs 97.7%
for missed, realized maker EV 0.0% (t = −0.02). The live book screens a
**filtered** universe (spread ≤ 4¢, volume/OI ≥ 500, 80–95¢, ≤ 60d,
ex-Sports) the backtest could not isolate. The open question this experiment
answers: **does adverse selection also kill the maker edge in the filtered
universe?** Early live signal: verified fill rate 92.3% (n=26; 95% CI ~76–98%,
not yet distinguishable from 73.6%).

## The frozen entry rule (unchanged since launch)

Favorites 0.80–0.95 ask · spread ≤ 0.04 · volume ≥ 500 or OI ≥ 500 ·
resolve ≤ 60d · ex-Sports · $200/position · max 50 concurrent · max
12/category · maker fill assumed at the bid · hold to settlement · never
re-enter a market.

## Verdict rule (the new pre-registration)

At **n = 100 fill-checked settles** (fill check = full entry→close candle
window covered), compute over the **verified-fills-only** subset:

- per-position EV (P&L ÷ cost), net of modeled maker fees
- verified fill rate with 95% CI

Decision:

- filled-only mean EV ≤ 0 → **mirage confirmed in the filtered universe
  too** — archive the book, the strategy is dead at retail.
- filled-only mean EV > 0 with t ≥ 2 AND verified fill rate ≥ 85% →
  **filtered-universe maker edge is real** — consider Exp 1b: small
  real-money replication with its own pre-registration.
- otherwise → extend to n = 200, then decide on the same thresholds or kill.

Supporting diagnostics (observed, never gating): fill-timing split by result
(late fills on losses = the adverse-selection fingerprint; "late" = fill in
the last quarter of the entry→close window), taker counterfactual, and the
per-category ledger.

## Fee model (verified against the live API, 2026-06-10)

Series carry a `fee_type`: of the 51 series held at registration, 43 are
`quadratic` (trading fee = ceil-to-cent(0.07 × C × P × (1−P)), **makers pay
0**) and 8 are `quadratic_with_maker_fees` (makers pay the quarter rate,
0.0175 × C × P × (1−P)) — the high-volume economics series: KXFED,
KXFEDDECISION, KXCPI, KXCPIYOY, KXU3, KXPAYROLLS, KXGDP, KXLLM1. The engine
records each position's `feeType` at entry and reports realized P&L net of
modeled maker fees. Headline P&L before 2026-06-10 ignored fees and is
overstated by the maker fees on those series.

## Instrumentation (additive only — entry rule untouched)

- `feeType` at entry (backfilled for pre-existing rows) → fee-adjusted P&L
- `askAtEntry` at entry (new entries only — not backfillable) → taker
  counterfactual: same contracts bought at the ask with taker fees
- `fillConfirmedAt` (since 2026-06-10) → verified-fill split + fill timing
- per-category ledger from existing `category` rows

## Known limitations (accepted)

- The first 76 positions predate fill-timing instrumentation start; their
  fills were back-checked over the full window, so confirmation is valid but
  `askAtEntry` is permanently null for them.
- Fee model covers trading fees only; Kalshi charges no settlement fee.
- Hourly candle resolution bounds fill-timing precision to ~1h.
