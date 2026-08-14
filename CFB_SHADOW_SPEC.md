# CFB Shadow Book — pre-registration (Experiment No. 6 gate)

**Status: PRE-REGISTERED 2026-08-13, BEFORE ANY PICK WAS GENERATED.** This
document freezes the method and the success criteria for a silent 2026-season
CFB paper book. The commit timestamp on this file is the proof that the verdict
criteria predate the data. Editing the criteria after picks begin logging voids
the experiment — if the method must change, the change is logged in an errata
section below and the sample restarts.

## The question (one sentence)

Does our cheapest deterministic machinery (ratings-based fair value vs the
de-vigged market) find positive closing-line value in the college football
market — enough to justify building a full CFB lab (Experiment No. 6: backtest
walk + doctrine loop + published receipts) for the 2027 season?

## Why silent

The NFL receipts page is the season's public commitment; its pre-mortem names
cadence collapse as the #1 death risk with ONE league. CFB this season is
therefore measurement only: no site section, no X posts, no LLM picks, no
doctrine, zero operator cadence obligations. Fully automated; if it silently
breaks for two weeks nothing of value is lost. The ledger still commits to the
repo — silent to the audience, git-notarized for the 2027 decision.

## Method (frozen)

- **Pick generator:** deterministic only. CFB team ratings (CollegeFootballData
  API — Elo or SP+, whichever the build finds cleaner; the choice is made ONCE
  at build time and recorded in the errata) → fair win probability → compared
  to The Odds API's de-vigged consensus via the existing `devig.ts` machinery.
  No LLM anywhere in the pick path.
- **Markets:** moneyline, spread, total — mirroring the NFL quant dry-run.
- **Edge floor:** 6% vs de-vigged fair, same as the house floor everywhere.
- **Scope:** FBS games with two-sided prices in The Odds API NCAAF feed. No
  conference filters, no bowl-season special-casing — filters invented after
  seeing results are the classic garden of forking paths.
- **Entry:** one snapshot sweep per week (Thursday UTC evening); every pick's
  entry price is the price at that sweep. Games without a price at entry are
  excluded, never backfilled.
- **Close:** one sweep Saturday in the pre-kickoff window. A pick with no
  captured close is graded for W/L but EXCLUDED from the CLV sample — labeled,
  never backfilled from another source.
- **Grading:** results from the CFBD API; CLV in probability points (de-vigged
  entry prob vs de-vigged close prob), same definition as the NFL ledger.
- **Storage:** `data/processed/cfb-shadow/ledger.json`, committed by the
  workflow. QUARANTINE: never touches AgentPick, ModelPickSnapshot, Turso, the
  site, or IN_SCOPE_LEAGUES — identical wall to the NFL lab's.
- **Stakes:** flat 1u paper, no Kelly — this measures the market, not bankroll
  management.

## Verdict criteria (frozen — the only part that matters)

Evaluated once, after the season's final regular-season Saturday (early Dec
2026). n = picks with a captured close.

| Outcome | Criteria | Action |
|---|---|---|
| **GREENLIGHT** | n ≥ 150 AND CLV beat rate ≥ 55% AND avg CLV ≥ +1.0pp | Spec Experiment No. 6 (full CFB lab) for the 2027 season |
| **EXTEND** | n ≥ 150 AND beat rate in [52%, 55%) | Ambiguous — run the shadow book a second season, no build |
| **NO** | beat rate < 52%, or n < 150 by season end | The "college is softer" folklore did not survive our tooling; write the negative result into the lab notes and skip Exp 6 |

No other statistic — ROI, win rate, a hot conference, a great month — can
trigger a greenlight. ROI on n<200 flat-stake picks is noise; CLV is the only
score, here as everywhere.

## Build parameters

- **When:** Aug 25–28 buffer window, ONLY if the /nfl receipts build is on
  schedule; else early September. The receipts page never waits for this.
- **Effort cap:** ~1 day. If the build exceeds two days it gets cut for the
  season and this spec rolls to 2027 unmodified.
- **Runtime cost:** ~2 Odds API sweeps + 1 CFBD ratings pull per week
  (single-digit credits), one GH Actions cron, $0 model spend.

## Errata

(none — nothing may appear here except build-time choices explicitly deferred
above, and any mid-season method breakage with its restart date)
