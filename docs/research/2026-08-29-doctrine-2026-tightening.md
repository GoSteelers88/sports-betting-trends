# 2026 doctrine tightening — the holdout's consequences, locked before week 1

**Decided 2026-08-29, before the week-1 board publishes (Sept 8).** Operator
delegated the decision; this doc is the record. Every change below maps to a
line of the pre-registered 2025 holdout result
(`2026-08-18-holdout-validation-2025.md`) — nothing here is a new idea, only
the removal of things the holdout refuted. Implemented as a tightening-only
post-pass in `scripts/nfl-live-week.ts` (a leg can flip PLAY→PASS, never
PASS→PLAY).

## T1 — the moneyline floor becomes a CONJUNCTIVE gate: raw AND calibrated

The holdout's one positive finding: calibration transferred (1.1pp mean gap
between predicted and realized in the 0.5–0.6 bucket, n=684). Its central
negative finding: raw-confidence edges did not convert to edge vs the close in
ANY market. A PLAY now requires the edge to clear the floor under BOTH the
haircut raw confidence (the pre-existing gate) and the per-market
beta-calibrated probability. Floors are unchanged (3% divisional / 5%
non-divisional).

Why both, not calibrated-only: the walk's ML calibration corrects UPWARD
(realized ~66% vs mid-50s confidences), so a calibrated-only gate would be
LOOSER than the raw gate — and "a well-calibrated belief implies a big edge vs
fair" is precisely the claim the holdout refuted (ML ran −1.1% ROI despite
calibration holding). Requiring both keeps the tightening monotone: this gate
can only remove plays the old doctrine would have made, never add one. Both
edges print in every leg's notes.

Consequence accepted in advance: this predictably empties the board most
weeks. The frozen season-plan ruling — "the empty all-PASS board IS the launch
narrative" — was written for exactly this.

## T2 — ATS is retired for 2026

Holdout: ATS overall 48.6% (−7.2% ROI), dogs ATS −3.6% (a −13.2pp collapse
from the walk's +9.6%), favorites ATS −14.9%. There is no ATS slice with
out-of-sample support, and the dog doctrine was shown to be an in-sample
artifact that actively steered the book (67% of ATS picks were dogs). ATS
reads still print on the board; the verdict is always PASS.

## T3 — totals are retired for 2026

Holdout: 51.6% vs the 52.4% break-even (−1.6% ROI), on top of the walk's own
−12.1%. Same treatment as ATS.

## What this leaves

A moneyline-only playable surface gated on the one instrument the holdout
validated. The paper parlay block (≥3 ML PLAYs) becomes near-impossible to
trigger — accepted. The receipts page's verdict machinery (devigged CLV vs
sharp close, PLAY minus control, n≥150 or no verdict) is unchanged by any of
this; doctrine decides what publishes, the pre-registration decides how it is
judged.

## Un-freezing

These retirements hold for the 2026 season. Reinstating a market in 2027
requires new out-of-sample evidence (a fresh pre-registered validation), not a
good month.
