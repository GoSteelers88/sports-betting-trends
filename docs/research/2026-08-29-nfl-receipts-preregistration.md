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
