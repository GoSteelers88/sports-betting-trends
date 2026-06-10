# Experiment No. 3 — PEAD paper book (pre-registered)

**Hypothesis.** Post-earnings-announcement drift: stocks reporting an extreme
positive EPS surprise continue to drift up over the following month
(Bernard–Thomas 1989; still measurable in 2024–2026 studies, esp. overnight
drift after extreme surprises — Chan–Marsh SSRN 4765828). We test the
long side only, against SPY, with simulated orders on Alpaca paper.

This rule is **pre-registered**: the parameters below were fixed before the
first order. Tuning them after seeing results voids the test (start a new
numbered experiment instead).

## The rule

| Parameter | Value |
|---|---|
| Signal | Quarterly EPS surprise ≥ **+20%**, where \|estimate\| ≥ $0.05 |
| Source | Finnhub earnings calendar (yesterday AMC + today BMO reports) |
| Universe gates | Tradable on Alpaca · last price ≥ $5 · avg IEX dollar volume (5 sessions) ≥ $250k |
| Entry | Market order at the first weekday cron (15:05 UTC) after the report |
| Size | $500 notional per position · max 20 concurrent · $10k book |
| Exit | Market order at the first cron ≥ **28 calendar days** after entry |
| Benchmark | SPY captured at entry fill and at exit fill |
| Metric | Excess return = stock return − SPY return over the identical window |

One position per (symbol, report date). No re-entry, no shorts, no overrides.

## Kill / verdict criterion

At **n ≥ 40 settled positions**:

- mean excess ≤ 0 → **kill** (drift not harvestable at this cadence)
- mean excess > 0 with t ≥ 2 → drift is real here; consider next step
- otherwise → keep accumulating to n = 80, then require t ≥ 2 or kill

## Accounting

Same conventions as Experiment No. 1: positions held at cost, equity =
$10,000 + realized P&L (no mark-to-market noise in the curve). Fills are
Alpaca paper fills (taker, market orders during RTH) — unlike the Kalshi
book there is no assumed-maker-fill problem, but Alpaca paper fills carry
no market impact, so treat results as an upper bound.

## Known limitations (accepted)

- Finnhub free-tier estimate coverage filters the universe toward
  analyst-covered (i.e., liquid) names — acceptable, that's where we'd trade.
- IEX-only volume understates consolidated volume ~30–50×; the $250k gate is
  calibrated for that.
- Corporate actions during the hold: exit sells min(our qty, current Alpaca
  position qty); splits may distort an occasional position's P&L.
- Daily cron means entries are ~30–90 min after the open, not at the open —
  the measured effect is therefore drift *net of the open gap*, which is the
  conservative side of the literature.

## Operations

- Engine: `src/lib/stocks/` (peadLogic = pure, peadEngine = cycle, alpaca/finnhub = clients)
- Runner: `npm run paper:pead` · migrate: `npm run paper:pead:migrate`
- Cron: `.github/workflows/pead-paper.yml` — weekdays 15:05 UTC
- Secrets needed: `ALPACA_PAPER_KEY_ID`, `ALPACA_PAPER_SECRET`, `FINNHUB_API_KEY` (all free signups)
- State: Turso (`StockPaperPosition`, `StockPaperSnapshot`); dashboard reads DB only
