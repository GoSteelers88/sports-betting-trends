# /nfl receipts — pre-registration of the verdict machinery

**Status: FROZEN 2026-08-29, before any 2026 board was published.** The commit
timestamp on this file is the proof that every rule below predates the data.
Editing any frozen rule after the first board publishes voids the season's
metric; genuine breakage gets an errata entry in `ledger.json` and a sample
restart, never a silent edit.

Companion to `CFB_SHADOW_SPEC.md` (2026-08-13) and the 2025 holdout write-up
(`2026-08-18-holdout-validation-2025.md`). Implements the 2026-08-19 threat
brief. Code of record: `src/lib/nfl-receipts/` + `src/lib/nfl-clv-metric.ts`.

## 1. The verdict metric

**Paired differential: PLAY-arm devigged CLV beat rate MINUS control-arm beat
rate, over pairs where both arms graded.** Positive differential = evidence of
skill beyond the structural early-entry timing edge; the raw PLAY beat rate
alone is explicitly NOT the verdict (our own clv-proof experiment shows a
model-free timing edge exists at the same threshold).

- CLV is devigged (power method) against a sharp close; raw line-vs-line CLV
  is published alongside but decides nothing.
- **No ROI claim appears anywhere on /nfl.** The 2025 holdout was negative;
  the page links it. Calibration transferred; edge did not.

## 2. Sample-size rule (the formerly open decision — now closed)

**n ≥ 150 graded PLAY legs** is required for ANY verdict. If the season ends
with n < 150: **no verdict is issued, permanently.** The page states
"insufficient sample — no verdict" for the season; there is no partial-season
extrapolation, no threshold lowering, no "directionally encouraging" language.
The projected weekly rate (~1 PLAY / 48 legs at current doctrine floors) makes
n < 150 the LIKELY outcome — that is a fact about the doctrine's selectivity,
stated on the page from day one, not discovered in January.

## 3. Benchmark chain (re-registered)

The original chain `[pinnacle, circa, bookmaker]` was registered against a
data source that does not carry those books (The Odds API us-region has zero
Pinnacle/Circa/BookMaker at any purchasable tier) — it would have produced
n = 0 forever. Re-registered 2026-08-29, before any board:

| Tier | Book | Source | Role |
|---|---|---|---|
| 1 | pinnacle | own guest-API scrape (leagueId 889) | headline benchmark |
| 2 | lowvig, betonlineag (priority order) | Odds API us-region | fallback when no Pinnacle close was captured; every tier-2 verdict is flagged and counted next to n |
| — | all other books | — | soft closes: never counted (Buchdahl: devigged soft closes predict nothing) |

A higher tier always replaces a lower one; within a tier the latest pre-kickoff
capture wins. Every counted close's source snapshot is committed to the repo
(`data/processed/nfl-live/closes/`) so any reader can recompute any verdict.

## 4. Entry prices

- Entry price = **best available price across captured us-region books at the
  publish snapshot, at the leg's exact point**, with the book and snapshot
  recorded on the leg. The devig other-side comes from the same book.
- A leg whose exact point is not offered two-sided anywhere at publish is
  shown on the board but is **permanently CLV-ineligible** (`no_entry_price`).
  Never backfilled, never substituted with a moved point.
- Placeholder prices are extinct: no price appears on a board without
  provenance (book + committed snapshot + fetch time).

## 5. Control arm (frozen selection rule)

For each PLAY leg, a placebo leg is drawn from the SAME entry snapshot at the
same instant, by the deterministic rule in
`src/lib/nfl-receipts/control-arm.ts` (hash of the play leg's id over the
pool of same-market games carrying no PLAY leg; side by hash parity; main
line by cross-book mode). Control legs pass the same kickoff gate, are graded
by the same machinery against the same benchmark chain, and their ids are
fixed the moment the play leg's identity exists — the placebo cannot be
chosen in hindsight.

## 6. Statuses, coverage, and the anti-shrinking rule

Every published leg permanently occupies exactly one status:
`pending → graded | no_entry_price | no_close | non_sharp_close | void`.
**Coverage = graded / eligible is rendered next to every beat rate.** A leg
whose close was missed becomes `no_close` — the denominator registers the
gap; it never silently shrinks. Leg identity is
`sha256(boardFile|gameId|market|selection|point)`; the ledger upserts by that
id, so re-running capture or grading can never double-count.

## 7. Immutability + notary

Boards publish once to `data/processed/nfl-live/board-YYYY-wkNN.json` and are
never edited (corrections → ledger errata). At publish the board's SHA256 is
recorded in the ledger; grading refuses to run unless local bytes AND the
origin/master copy hash to the recorded value. Force-push protection on
master is asserted whenever a token permits; its absence is a CI failure.

## 8. Kickoff discipline

Every leg carries `kickoffUtc` from the free Odds API events endpoint. A leg
inside 12h of kickoff (or missing a kickoff) at publish time is dropped and
listed with its reason; the board itself is never delayed. Closes are only
recorded from captures taken before kickoff, with `minutesBeforeKickoff`
stored on every close.

## Errata

(none)

## Amendment 1 — 2026-09-09: the no-ROI rule is narrowed to live picks

**Status: AMENDED 2026-09-09.** The rule in §1 is not edited. It is narrowed by
this entry, and the original text stands above, unchanged, as written.

§1 reads: "**No ROI claim appears anywhere on /nfl.**" As of 2026-09-09 it reads:

> **No ROI claim appears anywhere on /nfl for a live pick.** No figure describing
> the return of any published board, any passed game, or the live CLV ledger
> appears on the page, and none ever will. The verdict metric is unchanged:
> paired PLAY-arm minus control-arm devigged CLV beat rate at n >= 150, and
> nothing else.

**What this permits, exactly.** /nfl gains a research appendix ("Part two"),
walled off from the live half by its own section front, republishing two
aggregate blocks from the committed `data/processed/nfl-exp5.json`:

- **Player props** — 671-401-7 over 1,079 settled picks, seasons 2019-2024.
  No ROI and no CLV are published for this block, because the data has neither:
  the picks were graded against nflverse box scores, never against a market
  price. The page prints a hit rate against a threshold and states, in the same
  block, that a hit rate is not a return.
- **Three-leg parlays** — 103-444 over 547 settled, seasons 2019-2024;
  flat-stake yield +38.96%, an 18.8% win rate against the 13.6% the odds
  require. **This is the ROI figure the original rule forbade.** It is graded
  against nflverse approximate closing lines, banks no closing-line value, and
  is published as an explicit optimistic upper bound — with that caveat set
  above the number, not below it.

The moneyline block (+8.21% ROI, 310 bets, seasons 2015-2024) is NOT published
on /nfl and this amendment does not permit it.

**What this still forbids.** Any ROI, yield, unit, bankroll or return figure for
a live pick, a published board, a passed game, or the CLV ledger. Any projection
from a backtest figure to a live expectation. Any backtest figure presented
without its in-sample span and the negative 2025 holdout adjacent to it in the
same block.

**Why.** The record behind the yield was already public on the site's homepage;
publishing the record while suppressing the number it produced was the more
misleading of the two available options. The frozen rule would also have barred
the site from ever showing its own working, which was never its purpose — its
purpose was to stop a live pick being sold on a claimed return.

**How this is disclosed.** The amendment is reproduced on /nfl itself, dated,
as "Amendment 1 — 2026-09-09", above the first research figure, quoting the
original §1 text beside the amended text. A pre-registration that can be edited
without the reader seeing the edit is not a pre-registration.

**Season spans were measured, not assumed** (2026-09-09): the props block reads
`data/private/nfl-loop/prop-picks-log.jsonl` (1,181 rows, seasons 2019-2024) and
the parlay engine reads `data/private/nfl-loop/picks-log.jsonl` (4,794 rows,
seasons 2019-2024). The moneyline block reads the quant book (310 bets, seasons
2015-2024). The public `nfl-exp5.json` carries no season field, so the span on
the page is a checked-in constant with a test guarding it.

**What is NOT amended.** §2 (n >= 150 or no verdict, permanently), §3 (benchmark
chain), §4 (entry prices), and the verdict metric itself are untouched and
remain frozen as of 2026-08-29.
