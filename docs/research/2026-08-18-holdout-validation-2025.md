# 2025 Holdout Validation — Result: NEGATIVE

**Run date:** 2026-08-18 · **Harness:** `npm run nfl:validate` (`255f9b4`) · **Cost:** $2.53

This was the pre-registered out-of-sample gate from the Aug–Sept 2026 season plan.
2025 was held out of `LOOP_SEASONS` from the start for exactly this run. Publishing
the result unchanged, favourable or not, is the point of pre-registering it.

## Conditions

- 22 weeks, 285 games, **855 graded rows** (complete season, no gaps).
- Doctrine frozen at `coverage: 2024 POST wk22`, injected into every pick.
  Leak gate asserted at run start: doctrine coverage is strictly before 2025 REG wk1.
- **No lessons written, no reflect call, no dream.** Week N+1 could not learn from
  week N. Results were graded into a quarantined log; the walk's `picks-log.jsonl`
  was never touched.
- Game markets only (props opt-in, not run).

## Result — the doctrine did not transfer

| Market | Record | Win % | 95% CI | ROI | Gate |
|---|---|---|---|---|---|
| ATS | 138-146-1 | 48.6% | [42.8, 54.4] | **−7.2%** | fails |
| Moneyline | 190-94-1 | 66.9% | [61.2, 72.1] | −1.1% | fails (break-even 68.4%) |
| Totals | 147-138 | 51.6% | [45.8, 57.3] | −1.6% | fails |
| Dogs ATS | 97-95 | 50.5% | [43.5, 57.5] | **−3.6%** | fails |
| Favorites ATS | 41-51-1 | 44.6% | [34.8, 54.7] | −14.9% | fails |

**Transfer (in-sample walk → holdout), ROI points:**
ATS +3.2% → −7.2% (**−10.4pp**) · dogs +9.6% → −3.6% (**−13.2pp**) ·
totals +3.6% → −1.6% (−5.1pp) · moneyline +0.9% → −1.1% (−2.0pp).

Every line fails its own price-implied eligibility gate. No market shows evidence
of edge out-of-sample.

## What did transfer: calibration

Mean calibration gap **1.1pp** (0.5–0.6 bucket: predicted 55.5%, realized 54.8%,
n=684). Across six in-sample seasons and one held-out one, the model's stated
confidence tracks its realized win rate. It knows how confident to be. That
confidence simply does not convert into edge against the closing line.

## Reading it honestly

- **The CIs are wide.** At n=284 ATS decisions, [42.8, 54.4] contains the 52.4%
  break-even. The correct claim is *"the in-sample edge did not replicate and
  there is no evidence of edge,"* not *"the model is proven to lose."*
- **The doctrine concentrated the book into the losing position.** It named
  underdogs "the single clearest cross-season edge," and 67% of ATS picks were
  dogs — which returned −3.6%. Doctrine did not merely fail to help; it steered.
- **This is the continuation of a visible decay, not a surprise.** Dog ATS ROI ran
  +20.5% (through 2021) → +14.0% (through 2023) → +9.6% (full walk) → −3.6%
  (holdout). It matches the published literature already on our debunked list:
  contrarian/home-dog systems died out around 2005–2011 as markets sharpened.
- **The entry-price re-grade could never have caught this.** It re-graded the
  *same picks* at opening instead of closing prices, and dogs survived (+19.4%).
  That tested price sensitivity, not generalization. Only new picks on unseen
  data could test generalization — and they failed. Re-grading is not validation.

## Consequences

1. **No ROI claim may appear on the receipts page.** The pre-registered verdict
   metric was already devigged CLV beat rate at real entry prices; this result
   removes any temptation to cite backtest ROI alongside it.
2. **Doctrine floors must tighten before Sept 8**, or the week-1 board publishes
   near-empty. The season plan already froze "the empty all-PASS board is the
   launch narrative" — that ruling now does real work.
3. **Calibration is the asset worth keeping.** It is what makes Kelly sizing and
   the confidence-gated doctrine legitimate, and it is the one property that
   survived the holdout.
4. The holdout is now spent. It cannot be re-run for a better number; any further
   2025 use is contaminated.
