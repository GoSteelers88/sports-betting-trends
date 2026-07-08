# Experiment No. 4b — Parlay paper book (pre-registered)

## Registration history

- **Exp 4a (registered 2026-06-14, superseded 2026-07-05):** exactly-3-leg rule.
  In 17 daily cycles it never assembled a single ticket — **0 parlays opened, 0
  settled** — because the daily playable pool (typically 1–7 legs, often
  same-team or the same player quoted at multiple books) never yielded 3
  uncorrelated legs across 3 distinct games that also survived the haircut.
  Per this spec's own rule ("start a new numbered experiment instead"), the
  rule change below is registered as **Exp 4b**. Nothing was tuned against
  performance data — there was none; the book was empty. The $10k book carries
  over untouched (only no-op equity snapshots exist).
- **Exp 4b (registered 2026-07-05, before its first parlay opened):** **2–3
  legs**, still one leg per distinct game, all other gates unchanged. Combo
  selection is explicit: enumerate every valid 2- and 3-leg combo, rank by
  parlay EV, greedily take non-overlapping combos. Because a 3-leg whose third
  leg is +EV always out-EVs its own 2-leg subset, the book prefers 3-leg
  tickets when the slate supports them and falls back to 2-leg tickets when it
  doesn't.

**Hypothesis.** If player-prop legs are each independently +EV against the
de-vigged sharp (Pinnacle) line, and they are drawn from *distinct,
independent games*, then the parlay of them is also +EV — and the
compounded edge pays for the higher variance. Concretely we expect a positive
realized **yield** (P&L ÷ amount staked) across a book of such parlays, even
though most individual parlays lose (a 3-leg parlay of ~55% legs hits ~17% of
the time; a 2-leg ~30%).

This is the natural extension of Experiment No. 1 (de-vig singles) and the
props board: those proved we can find legs whose soft price beats the sharp
fair value by ≥3% EV. Exp 4 asks whether *combining independent edges*
survives the parlay's multiplied vig and the estimation error in each leg's
fair prob.

This rule is **pre-registered**: the parameters below were fixed before the
first parlay opened. Tuning them after seeing results voids the test (start a
new numbered experiment instead).

## The rule

| Parameter | Value |
|---|---|
| Leg source | props-board log rows flagged `playable` (EV ≥ **3%** vs the de-vigged sharp prop line), deduped to the latest tick per (player, propType, side, line, book) |
| Leg eligibility | game `commence` still in the FUTURE at cycle time (no look-ahead) **and** a non-null `gameId` (a leg with no game identity is parlay-ineligible) |
| Legs per parlay | **2–3** (Exp 4b; was exactly 3 under 4a) |
| Combo choice | enumerate all valid 2- and 3-leg combos → rank by parlay EV (deterministic id tiebreak) → greedily take non-overlapping combos |
| Distinctness | every leg in a **distinct `gameId`** — same-game combos forbidden |
| Correlation block | even across games, refuse: same player; same-team stacks; a pitcher-strikeouts leg whose game contains a batter leg (same-game backstop). Skip reason `correlated`. |
| Open gate | parlay true EV `Π(fairProb_i · decimal_i) − 1` must be **> 0** AND survive a **−4pt-per-leg** fairProb haircut (estimation-error guard) |
| Recorded guard | the **flip-δ** (per-leg fairProb haircut that zeroes EV) is stored on every parlay |
| Stake | **¼-Kelly computed ONCE** on the combined prob `Π fairProb_i` and combined odds `decimalToAmerican(Π decimal_i)` — never the product of per-leg Kelly fractions |
| Caps | same as Exp 1: max **5%** of equity per parlay, **$10 min** stake floor |
| Exposure | each leg appears in at most **one** open parlay (no exposure double-count); `exposureUsd = Σ open parlay stakes` |
| Book | **$10,000** paper; `equityUsd = 10000 + Σ settled parlay P&L` |
| Idempotency | deterministic parlay id = sorted leg ids → re-running a slate opens no duplicate |

One parlay per distinct sorted-leg-id set. No overrides.

## Settlement

A parlay settles only when **all** its legs reach a terminal box-score result
(ESPN summary, via the shared `prop-grading.ts` lookup + `resolveProp`):

- all legs **won** → P&L = `stake · (decPar − 1)`
- any leg **lost** → P&L = `−stake`
- a **push** (actual exactly hits the line) or **void** leg (pitcher scratched /
  game postponed → `resolveProp` returns null after the game window closes)
  **DROPS** that leg and the parlay re-prices to the surviving legs at recombined
  odds. Both original legs and surviving legs are stored for auditability.
- **all** legs push/void → status `void`, full refund, P&L 0.
- any leg still unresolved → the parlay stays `open` and contributes **nothing**
  to wins/losses/win-rate (an unsettled parlay is never counted as a win).

Each leg is stored as a full sub-record (player, gameId, propType, line, side,
oddsAmerican, fairProb, status, actual, finalScore) plus parlay-level
`parlayDecimalOdds`, `parlayFairProb`, `parlayEV`, `flipDelta`, `stakeUsd`. The
on-call reader can answer "which leg lost parlay #4" from the JSON alone.

## Kill / verdict criterion

At **n ≥ 30 settled parlays** (won + lost; full-void refunds don't count):

- yield ≤ 0 → **kill** (compounded independent edges don't survive parlay vig +
  estimation error at this cadence)
- yield > 0 → continue accumulating to **n = 60**; at n=60 require yield > 0
  with the realized hit-rate ≥ the EV-implied hit-rate (`Σ parlayFairProb / n`)
  by a non-trivial margin, else kill.

Win rate alone is uninformative for parlays (most lose by design); **yield** is
the verdict metric. The 2-leg vs 3-leg yield split is **observational only**
(logged for the eventual read, never a mid-flight gate — n per bucket will be
small).

## Accounting

Same conventions as Experiment No. 1: parlays held at stake (exposure), equity =
`$10,000 + realized P&L` (no mark-to-market noise in the curve). Accounting is
DERIVED from the parlay rows — there is no running cash balance that can drift.

## Known limitations (accepted)

- **Independence is assumed, not proven.** Distinct `gameId` + the correlation
  block is our best available proxy. True cross-game correlation (e.g. weather
  systems, a shared umpire crew, leaguewide offensive environment) is not
  modeled — accepted as second-order for a measurement-only book.
- **Fair prob is an estimate.** Each leg's fairProb is the de-vigged Pinnacle
  line; it carries estimation error that compounds across three legs. The −4pt
  haircut gate and the recorded flip-δ are the guardrails; the test's whole
  point is to see whether real edge survives that error.
- **Soft prices may move.** We lock the price recorded on the props-board tick;
  the actual takeable price could differ. As with Exp 1 these are taker quotes,
  so there's no resting-maker-fill problem — but a stale tick can over- or
  under-state the entry edge.
- **Per-side team attribution is coarse.** The Odds API props feed tags the
  game's two teams but not which side the player is on; the same-team-stack
  correlation check uses both teams, so it is conservative (may over-block).
- **No parlay-specific book limits or correlated-parlay restrictions** are
  modeled — a real book would often refuse or limit these.

## Operations

- Engine: `src/lib/parlay-paper.ts` (pure assemble/EV/stake/settle + impure cycle)
- Runner: `npm run paper:parlay` · read-only: `npm run paper:parlay report`
- Dream (quarantined weekly memo, never touches the rule): `npm run paper:parlay:dream`
- Cron: `.github/workflows/parlay-paper.yml` — daily, after the props board logs
- State: `data/processed/parlay-paper-book.json` (created on first run; JSON-backed,
  same storage pattern as the de-vig book — no DB, no migration)
- Secrets needed: none for the cycle itself (reads the props-board log + ESPN
  public box scores). The dream uses `ANTHROPIC_API_KEY` + `DISCORD_WEBHOOK_URL`.
- Places **nothing** real: there is no Kalshi/Alpaca/sportsbook client anywhere
  in this experiment's code path.
