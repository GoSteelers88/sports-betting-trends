# NFL Backtest Learning Loop (private, quiet)

**Status: PRIVATE offseason training project.** Not wired to the dashboard, not
committed, not pushed. All state lives under `data/private/nfl-loop/` (gitignored).
The cadence ("1 week a day") is scheduled separately — there is no GitHub Action.

## Hypothesis

A frozen Claude model, given *only pre-game information* for an NFL week and a
running memo of its own past mistakes, can learn to beat the closing line across
ATS / moneyline / totals. The loop is the experiment: does feeding distilled
lessons forward measurably move the model's calibration and ROI as it walks
2023 → 2024 → 2025?

This is honest about its own ceiling (see "Optimistic-edge note" below). The
point is the *learning loop mechanics* and per-stat tracking, not a claim of a
deployable edge.

## The blind-pick-then-grade rule (load-bearing)

For each game the model sees a **blind input** built from a hard allowlist of
PRE-GAME fields only:

- teams, kickoff (gameday/gametime), week, season, game_type
- `spread_line`, `total_line`, `away_moneyline`, `home_moneyline`,
  `over_odds`, `under_odds` (these are nflverse's ~closing market lines)
- `away_rest`, `home_rest`, `div_game`, `roof`, `surface`, `temp`, `wind`
- `away_qb_name`, `home_qb_name`, `away_coach`, `home_coach`, `referee`, `stadium`
- standings-to-date (W-L-T, points for/against) computed ONLY from prior weeks
- **per-game injury reports** scoped to ONLY that game's two teams for that exact
  `(season, phase, week)` — each row is `(player, position, status, injury)` where
  status ∈ {Out, Doubtful, Questionable, None}. Source: nflverse weekly injury
  release (`injuries_<season>.csv`). Injury reports are **published pre-game**, so
  this is not look-ahead; the parser keeps a report-only allowlist (the source CSV
  has no score/result columns at all) and `buildBlindWeek` never attaches another
  team's or another week's rows. Empty arrays when the cache is absent (offline-safe).
- the accumulated lessons memo

**ZERO post-game fields** ever enter the blind input: no `away_score`,
`home_score`, `result`, actual `total`, or anything derived from them. The
grader reads the full game row from a *separate* path. A unit test
(`no-leakage.test.ts`) serializes every blind input for a week and asserts none
of the forbidden tokens appear. If that test ever fails, the experiment is void.

Grading happens AFTER the picks are committed, against the real result:

- **ATS**: `result` (home margin) vs `spread_line`. Push when exactly on the number.
- **Moneyline**: winner by score. (Ties → push/void; rare but real in the NFL.)
- **Total**: actual `total` vs `total_line`. Push when exactly on the number.

## The markets (every game, every market)

Per game the model returns, as validated JSON:

| Market | Pick shape |
|---|---|
| ATS | side (`home`/`away`) + the spread it's taking |
| Moneyline | winner (`home`/`away`) |
| Total | `over`/`under` + the total it's taking |

Plus a `confidence` in `[0,1]`, a cited `rationale` (2-4 sentences naming the
specific factors behind each market pick), and a `keyFactors: string[]` (3-6 short
auditable factor tags) per game. Output is forced to JSON and validated; malformed
games — including any game whose `keyFactors` is empty — are dropped (logged), not
guessed.

### The per-game factor checklist (the pick prompt enforces it)

The pick prompt forces the model to reason through EVERY factor for EACH game
before committing, citing actual values (not vibes). The enumerated checklist:

1. **Market lines** — spread (`spreadLineHome`, negative = home favored), total,
   moneylines — the sharp baseline to justify deviating from.
2. **Injuries** — the per-game scoped report list, weighted by position/depth
   (a QB/OL/CB1 *Out* moves a line far more than a backup; Doubtful ≈ out;
   Questionable is a coin flip).
3. **Rest / bye edge** — `awayRest` vs `homeRest` (bye = +rest; short week = fatigue).
4. **Divisional game** — `divGame` games run tighter / closer to the number.
5. **Home / away** — home field, travel, body-clock.
6. **Dome vs outdoor + surface** — `roof` + `surface` (dome/turf lean totals up).
7. **Weather** — `temp` / `wind`; wind 15+ mph suppresses passing/kicks → under/run.
8. **QB matchup** — `awayQb` vs `homeQb` talent gap / backup starting.
9. **Coaching** — `awayCoach` vs `homeCoach` situational edges.
10. **Referee** — crew tendencies (flag-heavy crews nudge totals).
11. **Standings / form** — `awayRecord` / `homeRecord` incl. scoring margins.
12. **Lessons memo** — apply the carried-forward corrections.

`keyFactors` makes the reasoning auditable: each tag names a specific factor that
moved a pick (e.g. "home QB out (concussion)", "18mph wind -> under", "off bye, +7 rest").

## Season order

Strict chronological walk via a persisted cursor (`cursor.json`):

```
2023 REG wk1 … wk18 → 2023 POST (wk19 WC → wk20 DIV → wk21 CON → wk22 SB)
2024 REG wk1 … wk18 → 2024 POST
2025 REG wk1 … wk18 → 2025 POST
→ "caught up — awaiting live season" (no pick, no advance past the end)
```

nflverse labels postseason rounds individually (`WC`/`DIV`/`CON`/`SB`); we fold
all four into the POST phase, and the source week numbers (19→22) preserve the
round order. One week per invocation. REG before POST within a season. The cursor advances by
exactly one *populated* week per successful run.

## Idempotency / failure story

Order per run: **pick → grade → append → write lessons → advance cursor.**

- The picks log (`picks-log.jsonl`) is keyed `gameId|market`. Re-running the same
  week upserts the same rows — no double-count.
- Lessons writes overwrite the same file (idempotent).
- Cursor advance is the commit point. If the process dies before it, the same
  week is re-processed cleanly on the next run.

So the worst-case crash (mid-week, after some picks, before cursor advance) is
fully recoverable: re-run the week, get identical rows, advance once.

## Stat tracking ("every stat")

All stats are **derived from the graded picks log** (never a running counter).
Overall W-L-push + ROI (real spread/total odds; -110 default when missing) for
ATS / ML / totals, plus splits:

- favorites vs underdogs
- home vs away
- divisional vs non-divisional
- dome vs outdoor (roof)
- by rest advantage bucket
- by wind bucket / temp bucket
- by confidence bucket (calibration: predicted vs realized)
- favorite-cover rate, over rate (base-rate sanity)

## The learning loop

After grading, Claude reflects (`nfl-agent.ts` reflect call) on the week's
hits/misses and writes `lessons/<season>-wkNN.md` (a few hundred words, capped).
A rolling `lessons-current.md` (last N weeks distilled) is injected into the NEXT
week's pick prompt. That injection is the closed loop.

## Optimistic-edge note (honesty)

nflverse `spread_line` / `total_line` / moneylines are **~closing lines**. Any
edge the model shows is therefore *optimistic*: beating a closing line in a
backtest is far easier than beating the line you could actually have bet, and
there is no slippage, no limits, no line-shopping friction here. Treat every
positive ROI as an upper bound, not a tradeable result. This is a learning-loop
study, not a betting system.

## Operations

- Engine: `src/lib/nfl-loop.ts` (pure: parse / blind-build / grade / stats / cursor),
  `src/lib/nfl-agent.ts` (the Claude pick + reflect calls, structured + validated).
- Ingest games: `npm run nfl:ingest` → caches nflverse `games.csv` locally.
- Ingest injuries: `npm run nfl:ingest-injuries` → fetches the per-season nflverse
  injury assets (`injuries_<season>.csv`; the combined `injuries.csv` asset 404s)
  and caches `injuries.csv`. Parses before writing; never caches a partial file.
- Run one week: `npm run nfl:week` (pick → grade → learn → advance). Loads injuries
  if cached and attaches them per game; runs fine without them (empty arrays).
- Read-only report: `npm run nfl:week report` (no key / no network).
- State: `data/private/nfl-loop/{games.csv, injuries.csv, cursor.json, picks-log.jsonl, lessons/}`.
- The pick step needs `ANTHROPIC_API_KEY`; `report` and all tests run without it
  (the pick function is injected; tests never touch the network).
