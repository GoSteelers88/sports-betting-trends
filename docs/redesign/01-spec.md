# 01 — Spec: one front door (product-manager, 2026-09-12)

Reads `00-context.md` as ground truth. This document turns the approved decision into a buildable pitch: fates for every panel, the exact "today" list, the shared header, the redirect map, a scope ladder, the rabbit holes, the numbers that say it worked, and the briefs. Decisions, not menus. Downstream: `02-art-direction.md` (creative-director), `03-threat.md` (systems-reviewer), then the frontend-designer build and one crit round.

## 0. Facts I measured that change the shape (beyond 00-context)

Each of these altered a decision below; each is verifiable in the worktree.

1. **`data.picks.games` / `data.picks.props` never contain NFL.** `loadTodaysPicks()` filters `league IN (NBA, MLB, WNBA, NHL)` (`src/app/_data/dashboard.ts:~985`). So the "today" list needs no de-duplication between agent NFL picks and NFL board legs — NFL rows come from the board only, by construction.
2. **The "today" window is `createdAt >= UTC midnight`, not game time.** Picks created by the 22:37 UTC run vanish from `picks.*` at 00:00 UTC (8 PM EDT) while their games are still in play. Pre-existing, in a protected file. The list works with the data as given; the settled table (36h `gameDate` window, includes pending) catches what falls through. Fix is LATER.
3. **`SlatePick` carries no start time** (`dashboard.ts:45-69`). A today list that cannot say *when* is not a today list. This is the one unavoidable `dashboard.ts` change: add `gameDate: string | null` to `SlatePick` and to both mappers (`~1007`, `~1574`). Nothing else in that file moves.
4. **`NflWeek` (homepage) and `MarketNow` (/nfl `#market`) render the same file** (`data/processed/nfl-slate.json`); `MarketNow.tsx` says so in its header. `NflWeek` is a duplicate and is cut.
5. **`NflExp5` (homepage card) and `ResearchAppendix` (/nfl `#research`) render the same file** (`data/processed/nfl-exp5.json`). The card stays on `/experiments` but shrinks to a summary that links to the appendix; the "Experiment No. 5" name collision dies with the card's eyebrow.
6. **The published board today: `board-2026-wk01.json` = 50 legs, 2 PLAY (NYJ ML +106 @ FanDuel, Sun 1:00 PM ET; GB ML +105 @ DraftKings, Sun 4:25 PM ET), 46 PASS, 2 CONTROL; `ledger.json` all 50 rows `pending`.** So on launch day the today list has exactly 2 live rows and 0 agent picks — the empty-agent state is the launch state.
7. **No cron publishes NFL boards** (`.github/workflows/`: `nfl-closes`, `nfl-grade` only). "Next NFL board" cannot be a timestamp; it is derived from the slate's earliest future kickoff ("before Thu Sep 17 8:15 PM ET").
8. **`MarketFeed` is a `"use client"` component taking `games` as a prop — it does not read `node:fs`.** The only `node:fs` importer in `_components/` is `NflWeek` (being cut). The five books/QuantDesk are server components whose *libraries* read files — they still must never be imported from a client file.
9. **`/nfl` is `export const dynamic = "force-dynamic"`** today (reads committed JSON only, zero DB). Left alone in this build; see NEVER.
10. **`.receipts-mast` is `position: sticky; top: 0; z-index: 20`.** A layout-level sticky site header would collide with it. The mast becomes static (in-flow) on `/nfl`.
11. **`next.config.ts` warns, in its own words, that a route reading `data/processed` files at a runtime-built path ships an EMPTY SECTION over good data unless listed in `outputFileTracingIncludes` — and that it already happened once on `/nfl`.** Every new route that reads files gets an entry. This is the elephant of this build (see §8).
12. Component count: 30 files in `_components/` (the context doc's 29 omits `Footer.tsx`, 23 lines) + 2 in `nfl/_components/`. All 32 are in the inventory (§3).

## 1. Job to be done, per audience

**The X visitor, on a phone, from a receipts post.** They tapped a link under a screenshot of a PLAY stamp. They are hiring the site to answer *"is this real — what's his record, and what's on right now?"* before deciding whether to follow the account. They fire the alternative of scrolling the X thread for the numbers. Today the front door answers with a locked stamp, −7.1%, "No edge found", and one `<a>` element 3,500px down; the two live NFL plays the post was about are not on the page. **One-screen question at 390px:** *"What is live right now, and is this desk honest about its record?"* — answered by the verdict line ("The book is −7.1% ROI over 119 graded") plus the first live row, both above y = 844px.

**Nate, as operator.** Twice a day he wants to know whether the agent ran, what it shipped, and whether anything moved on the gate; weekly he checks the experiments and the kill room. Today that means clicking through five hash tabs whose contents overlap, with the liveness signal ("LAST RUN 3D AGO" — the agent has not written an `AgentRun` row in three days, which is itself an operator alert) buried in a strip he has learned to ignore. **One-screen question at 390px on `/`:** *"Did the agent run, and what did it ship?"* — answered by the run line ("Last run 3d ago · next Sat 6:30 PM ET") directly above the today list. On `/desk`: *"What died and why, and where is the gate?"* — answered by the jump list and the kill-room headline in the first screen.

## 2. Appetite

**One frontend-designer build session plus one creative-director crit round.** Scope bends to this, not the reverse. The build is: 2 new routes, 1 shared header, 1 new list component, 1 file-reading loader (~80 lines), 1 nav registry with a test, 1 client redirect shim (~20 lines), 1 `next.config` redirect, 9 deletions, and condensing edits to 4 existing panels. No data logic beyond reading the board file. Anything in SHOULD is dropped at the crit without discussion if the MUSTs are not clean.

## 3. Page-by-page content inventory

Rules: every **content panel** appears on exactly one route after the redesign. **Chrome** (header, footer, section heading, chat island, motion, formatting helpers) and **primitives** (tables, modal, charts used inside a panel) are not panels and may appear wherever their host is. Section ids are the existing ones — no renames, so anchors keep working.

| # | File (lines) | Kind | Today | After | Fate | Reason |
|---|---|---|---|---|---|---|
| 1 | `AskTheDesk.tsx` (757) | chrome | `/` + `/nfl`, `position: fixed` tab bottom-right | `/` (scope default) + `/nfl` (scope nfl), **in-flow** above the footer | MOVED (closed affordance only) | The fixed tab covers the GATE row on `/` and the GB@MIN stamp on `/nfl` at 390. Only the *closed* launcher moves into the document flow; the open sheet, transcript, fetch and `/api/chat` contract are untouched. Not added to `/desk` or `/experiments`. |
| 2 | `CommandHeader.tsx` (85) | chrome | sticky telemetry strip on `/` | — | CUT | Replaced by `SiteHeader`. Its `rel()` / `fmtEt()` helpers move to `format.ts` for `RunMeta` (§5). |
| 3 | `DeploymentGate.tsx` (202) | panel | `/` tonight tab | `/desk#deployment-gate` | MOVED as is | The 5-criteria contract is operator detail. `/` keeps the funding stamp plus "2/5 criteria clear" as a link to it. Removes the second FUNDING stamp from `/` and ~1,900px at 390. |
| 4 | `DevigEquityCurve.tsx` (93) | primitive | inside DevigPaperBook/QuantDesk | unchanged | KEPT | Chart used by its hosts. |
| 5 | `DevigPaperBook.tsx` (226) | panel | `/` experiments tab | `/experiments#devig-paper-book` | MOVED as is | Experiment No. 2. |
| 6 | `Footer.tsx` (23) | chrome | `/` operations tab only | `/`, `/desk`, `/experiments` (once per page) | KEPT | `/nfl` keeps its own `receipts-footer` colophon (content, not chrome). |
| 7 | `Hero.tsx` (276) | panel | `/` masthead | `/` (`#front-page`) | CONDENSED | Keep: nameplate, dateline, FUNDING stamp, the verdict `h2`, Status / Last-night lines, rail rows Net + Gate (Gate becomes `<a href="/desk#deployment-gate">`). Cut: the "Tonight" teaser line and rail rows Tonight + Slate (the list replaces them), and the `SettledTable` mount (page.tsx mounts it after the list). Eyebrow gains NFL ("NBA · MLB · WNBA · NFL desk") — NFL has been in scope since 09-10. Budget: lead ≤ 640px tall at 390. |
| 8 | `KalshiEquityCurve.tsx` (98) | primitive | inside 3 books | unchanged | KEPT | Chart. |
| 9 | `KalshiPaperTrail.tsx` (361) | panel | `/` experiments tab | `/experiments#kalshi-paper-trail` | MOVED as is | Experiment No. 1. |
| 10 | `KillRoom.tsx` (353) | panel | `/` the-desk tab | `/desk#kill-room` — **first panel on the page** | MOVED as is | Operator's first question is "what ran, what died"; the run log lives here. |
| 11 | `LastNightLedger.tsx` (140) | primitive | `SettledTable` in Hero + PropsDesk | `/` (games, mounted by page.tsx after the today list) + `/desk` (props, inside PropsDesk) | KEPT | Two different datasets, one table component. On `/` it filters out ids already in the live list (§4). |
| 12 | `MarketFeed.tsx` (353) | panel | `/` operations tab | `/desk#market-feed` | MOVED as is | 65 rows + 33 filters is an operator tool; it already defaults to desk scope and scrolls inside its own container. |
| 13 | `MlbPropPlays.tsx` (217) | panel | `/` tonight **and** props tabs | `/desk#mlb-prop-plays` (after PropsDesk) | MOVED as is (once) | Model ladder board; hides itself with no MLB slate. |
| 14 | `NflExp5.tsx` (310) | panel | `/` tonight **and** experiments tabs | `/experiments#nfl-exp5` | CONDENSED (once) | Stat strip + one link "Full backtest → /nfl#research". Example game/prop rows cut (they render on `/nfl#research` from the same file). Eyebrow becomes "NFL BACKTEST · RESEARCH DRY-RUN"; the string "Experiment No. 5" no longer appears on `/experiments`. |
| 15 | `NflWeek.tsx` (149) | panel | `/` tonight **and** operations tabs | — | CUT | Same file as `MarketNow` on `/nfl#market`. Its "picks live on /nfl" job is done by the today list's NFL rows and the empty state's next-board line. |
| 16 | `OverallLedger.tsx` (260) | panel | `/` tonight tab | `/#ledger` (after the settled table) | KEPT (condense is SHOULD) | The honest record: by-league table, win rate, ROI, streaks. SHOULD: shrink the oversized cumulative-units figure to rail size and drop the "IN RED INK" tag — the Hero rail already prints Net. |
| 17 | `ParlayPaperBook.tsx` (370) | panel | `/` tonight **and** experiments tabs | `/experiments#parlay-paper-book` | MOVED as is (once) | Experiment No. 4. |
| 18 | `PickAutopsy.tsx` (360) | primitive (modal) | opened by TonightsPlay + PropsDesk | opened by `TodayList` (`/`) + PropsDesk (`/desk`) | KEPT | The agent row's tap target. |
| 19 | `PropsDesk.tsx` (409) | panel | `/` props tab | `/desk#props-desk` | MOVED as is | Prop survivors, settled props, prop account, signals table — operator depth. Live prop picks also appear as rows in the today list (that is data, not a panel). |
| 20 | `QuantDesk.tsx` (258) + its `SectionHeader` block from `page.tsx` (`#quant-desk-section`) | panel | `/` the-desk tab | `/desk#quant-desk-section` | MOVED as is | Experiment-grade MLB paper book. |
| 21 | `SectionHeader.tsx` (61) | chrome | every panel | every panel | KEPT, `index` made optional and **never rendered** | Folio numbers dropped (owner). Callers may keep passing `index`; it prints nothing. |
| 22 | `StockPaperBook.tsx` (233) | panel | `/` experiments tab | `/experiments#pead-paper-book` | MOVED as is | Experiment No. 3. |
| 23 | `SurvivorBrief.tsx` → `TonightsPlay` (249) | panel | `/` tonight tab | — | CUT | Replaced by `TodayList` (§4). The thesis / what-kills-it / stats it told for one pick remain one tap away in `PickAutopsy`. |
| 24 | `SystemMemory.tsx` (155) | panel | `/` operations tab | `/desk#system-memory` | MOVED as is | Back of book. |
| 25 | `TabShell.tsx` (116) | chrome | `/` | — | CUT | Real routes replace hash tabs. |
| 26 | `VerdictTape.tsx` (52) | chrome | `/` | — | CUT | Owner: drop the ticker. (Repeats one item ×3 today.) |
| 27 | `VolatilityInputs.tsx` (139) | panel | `/` operations tab | `/desk#volatility-inputs` | MOVED as is | Injury wire, collapsed by default. |
| 28 | `motion.tsx` (146) | chrome | — | — | KEPT | Unchanged. |
| 29 | `format.ts` (106) | chrome | — | — | KEPT (+2 helpers) | Receives `rel()` and `fmtEt()` from CommandHeader. |
| 30 | `verdict-tape-items.ts` (89) | chrome | `/` | — | CUT | Dies with the tape. |
| 31 | `nfl/_components/MarketNow.tsx` (141) | panel | `/nfl#market` | `/nfl#market` | KEPT as is | Now the site's only rendering of `nfl-slate.json`. |
| 32 | `nfl/_components/ResearchAppendix.tsx` (333) | panel | `/nfl#research` | `/nfl#research` | KEPT as is | Now the site's only full rendering of `nfl-exp5.json`. |

**New files (all small):**

| File | Kind | Notes |
|---|---|---|
| `src/app/_components/SiteHeader.tsx` | chrome, server | Mounted once in `layout.tsx`. Wordmark + `<SiteNav />`. Zero data props. |
| `src/app/_components/SiteNav.tsx` | chrome, `"use client"` | `usePathname()` for `aria-current`. Renders `NAV` from `site-nav.ts` as `<a href>`. No `node:fs`, no data. |
| `src/app/_components/TodayList.tsx` | panel, `"use client"` | `/#today`. Props are plain serialisable objects (agent picks + NFL legs). Owns the autopsy `useState`. |
| `src/app/_components/RunMeta.tsx` | chrome, server | One line: last run / next run. Mounted on `/` (above the list) and `/desk` (under the jump list). |
| `src/app/_components/JumpList.tsx` | chrome, server | In-page anchor row, `<nav aria-label="On this page">`. `/desk` and `/experiments` only. |
| `src/app/_components/LegacyHashRedirect.tsx` | chrome, `"use client"` | Mounted on `/` only. Reads `location.hash` once on mount; `location.replace()` to the allowlisted target (§6). Renders nothing. |
| `src/app/_data/live-actions.ts` | server, `node:fs` | Reads `data/processed/nfl-live/board-*.json` (latest by season/week via `boardFileName` semantics) and `nfl-slate.json`; returns `{ nflLegs, nextBoardHint }`. Imported by `page.tsx` only. |
| `src/lib/site-nav.ts` + `src/lib/__tests__/site-nav.test.ts` | lib + test | `NAV` (4 entries), `LEGACY_HASH_TARGETS`, `legacyHashTarget(hash)`. Replaces `site-tabs.ts` + its test. |
| `src/app/desk/page.tsx`, `src/app/experiments/page.tsx` | routes | Server components, `revalidate = 300`, own `metadata`. |

**Deleted:** `TabShell.tsx`, `CommandHeader.tsx`, `VerdictTape.tsx`, `verdict-tape-items.ts`, `SurvivorBrief.tsx`, `NflWeek.tsx`, `src/lib/site-tabs.ts`, `src/lib/__tests__/site-tabs.test.ts`, `src/app/picks/page.tsx` (and the empty dir).

**Route composition, top to bottom:**

- `/` — `Hero` (condensed) → `RunMeta` → `TodayList` (`#today`) → `SettledTable` (games, last 36h, minus live ids) → `OverallLedger` (`#ledger`) → `AskTheDesk` (in-flow) → `Footer`. `LegacyHashRedirect` mounted (invisible).
- `/nfl` — unchanged below its head: `MastheadStrip` (now static) → `receipts-head` → boards → `MarketNow` → rules → ledger → errata → `ResearchAppendix` → `AskTheDesk scope="nfl"` (in-flow) → `receipts-footer`. `ReceiptsNav` deleted.
- `/experiments` — page head ("Side bets, on paper", the existing `#experiments` `SectionHeader` copy) → `JumpList` → `KalshiPaperTrail` → `DevigPaperBook` → `StockPaperBook` → `ParlayPaperBook` → `NflExp5` (condensed) → `Footer`.
- `/desk` — page head ("The desk") → `JumpList` → `RunMeta` → `KillRoom` → `DeploymentGate` → QuantDesk block → `MarketFeed` → `PropsDesk` → `MlbPropPlays` → `SystemMemory` → `VolatilityInputs` → `Footer`.

## 4. The "today" list on `/`

**Section:** `<section id="today">`, eyebrow "TODAY", headline states the count ("2 live plays" / "Nothing live"). Directly above it, `RunMeta`: "Analyst last ran 3d ago · next run Sat 6:30 PM ET" (from `data.status.lastAgentRunAt` / `nextScheduledRunUtc`, the same fields CommandHeader read). If the last run is more than 26h old the line prints in `--hold` — same number, honest tone.

**What qualifies as a live action** (server-side, in `page.tsx` + `live-actions.ts`; `now` is render time under ISR, so ±5 min):

1. **Agent game picks:** every `data.picks.games` row with `outcome === null` and (`gameDate` null OR `gameDate + 4h > now`). Kind `game`.
2. **Agent prop picks:** same rule over `data.picks.props`. Kind `prop`.
3. **NFL board PLAY legs:** from the latest published board (highest season, then week, in `data/processed/nfl-live/`), legs with `verdict === "PLAY"` and `kickoffUtc + 4h > now`. `PASS` and `CONTROL` legs never appear. A board `parlay` object, if present, is LATER. Kind `nfl`.

**State per row:** `upcoming` (start time > now), `in play` (start ≤ now < start + 4h), and for agent rows with a null `gameDate`, `pending` (no time known). Rows with an `outcome` leave the list; they belong to the settled table below, which is `data.lastNight.games.picks` filtered to ids not in the live list — so no pick is printed twice on `/`. Last night's *props* stay on `/desk` inside `PropsDesk`, as today. Four hours is a game's length plus slack; a pick that finished but is not graded until the 13:00 UTC grader shows in the settled table as `pending` (existing behaviour).

**Ordering:** start time ascending across all kinds (agent `gameDate`, NFL `kickoffUtc`); rows with no start time go last, ordered by edge descending (the existing TonightsPlay convention).

**One row shows** — two lines at 390, one line at ≥ 768:

- `game`: league tag · matchup · start time ET · state tag / selection @ American odds · edge (`+X.X%`) · stake (`0.50u`). Tap → `PickAutopsy` (button). CLV pending/pp prints in the autopsy, not the row.
- `prop`: league tag · player · `OVER 24.5 pts` · start time · state / matchup · @ odds · edge · stake. Tap → autopsy.
- `nfl`: `NFL` tag · matchup · kickoff ET · state / `NYJ ML +106 @ FanDuel` · `model 63% · market 47%` · a real link "on the board →" to `/nfl#play-<legId>` (that id exists today: `play-card` articles). **No units, no stake, no ROI, no CLV on NFL rows — anywhere on the site.** Amendment 1 forbids ROI/units for live NFL picks on `/nfl`; the front page inherits the rule so that a screenshot of `/` can never contradict `/nfl`.

Numbers come from the same fields and the same functions the current panels use: agent rows from `SlatePick.*`; NFL rows via `gameRows(board)`, `modelProbPct(leg)`, `marketProbPct(leg)`, `fmtAmerican`, `etDayLabel`, `etTimeLabel` from `@/lib/nfl-receipts/receipts-view` — the exact helpers `/nfl` renders with (the page's own header: "there is one devig implementation in this repo and this page does not add a second"). Importing from `src/lib/nfl-receipts/` is read-only use and allowed; modifying anything under `src/lib/nfl-*` is not. The row invents nothing; if a field is null it prints an em-dash, as `format.ts` already does.

**Empty state** (no rows at all). Say it once, then say what is next. Two lines, no illustration, no "check back soon":

- Line 1 (headline size): "Nothing is live." Sub: "Nothing cleared the 6% floor and the critic, and no NFL play is inside its window." (existing copy lineage from TonightsPlay.)
- Line 2 ("Next"): "Analyst runs Sat 6:30 PM ET (in 3h) · NFL week 2 board publishes at least 12h before Thu Sep 17 8:15 PM ET." The run time is `status.nextScheduledRunUtc`; the board line is `latestBoard.week + 1` plus the earliest `kickoffUtc > now` in `nfl-slate.json`, formatted ET. If the slate has no future kickoff: "NFL board: the slate refreshes daily; no kickoff inside the week window." If no board has ever been published: the week-1 copy already on `/nfl` ("publishes at least 12h before the Thursday kickoff").

Partial states are not special: 0 agent rows + 2 NFL rows is just a 2-row list (that is launch day). The "Next" line prints under the list in every state, so the next run/board is always on the page.

## 5. Shared header

One `<header>` in `layout.tsx`, sticky at top, one row, ≤ 48px tall at 390, `bg-paper`, bottom rule. Identical on every route. No data props, so it costs nothing on `/nfl` (which today makes zero DB calls — that stays true).

- Left: wordmark `NATESTACKS` as `<a href="/">` (the existing mark from CommandHeader, red asterisk included — creative-director may drop the asterisk).
- `<nav aria-label="Site">` with exactly four `<a href>` links, in this order and with these labels: **Today** `/` · **NFL** `/nfl` · **Experiments** `/experiments` · **Desk** `/desk`. `aria-current="page"` on the active one (`usePathname`). No numbering, no "T1", no folio. Keyboard-reachable, visible focus. If four links plus the wordmark do not fit at 390 the nav row scrolls sideways (the existing `/nfl` rail rule: a nav rail may scroll, content may not) — no hamburger, no drawer.
- Right: nothing.

**What survives from `CommandHeader`, and where:** LAST RUN and NEXT → `RunMeta` on `/` and `/desk` (same fields). FUNDING → the Hero stamp on `/` and `DeploymentGate` on `/desk`. DAY → the Hero dateline already prints "day 30 / No. 030". **Cut:** MODE PAPER (the nameplate says "The Paper Trial"; it is a constant), the pulsing dot, and the funding tag in the header (it would drag 25 Turso round-trips onto `/nfl`).

`/nfl` specifics: `ReceiptsNav` (function + call + the `TABS`/`tabHref` import) is deleted. `MastheadStrip` stays as content but `.receipts-mast` becomes `position: static` (its tokens RESEARCH LAB · NO ROI CLAIM · NOT BETTING ADVICE and the "2026 · WK 1" folio are read once on arrival). `.receipts [id] { scroll-margin-top: 90px }` is replaced by one global `[id] { scroll-margin-top: 56px }` so anchors clear the single sticky header on every route.

Route titles (template `%s · NATESTACKS` is in layout and stays): `/` inherits the root default (unchanged, keeps the OG card); `/nfl` unchanged; `/experiments` → title "Experiments", description "Four $10k paper books and the NFL backtest, on paper."; `/desk` → title "The desk", description "Operator view: kill room, funding gate, quant desk, the board, props, house rules, injury wire." `robots.ts` allow list becomes `/`, `/nfl`, `/experiments`, `/desk`, `/api/og/`.

## 6. Redirect / compat map

Hash fragments never reach the server, so `/#x` links can only be handled after `/` loads. `LegacyHashRedirect` (client, mounted on `/` only) reads `location.hash` once on mount and calls `location.replace(target)` with a target taken from a literal table — **never** built from the input. Unknown hashes do nothing (the page is `/`, which is a sane landing). `/picks` is a server redirect in `next.config.ts` (`redirects()`, `permanent: true` → 308); its page file is deleted.

| Old link | Lands on | Mechanism |
|---|---|---|
| `/picks` | `/` | `next.config.ts` redirect, 308 |
| `/#tonight` | `/` (hash cleared) | client shim: `history.replaceState` to `/` |
| `/#tonights-play` | `/#today` | client shim |
| `/#front-page` | `/` | client shim |
| `/#the-desk` | `/desk` | client shim |
| `/#props` | `/desk#props-desk` | client shim |
| `/#experiments` | `/experiments` | client shim |
| `/#operations` | `/desk#market-feed` | client shim |
| `/#nfl-week` | `/nfl#market` | client shim |
| `/#quant-desk-section` | `/desk#quant-desk-section` | client shim |
| `/#back-of-book` | `/desk#system-memory` | client shim |
| any other `/#…` | stays on `/` | no-op |

Every target id in the table exists today under the same name (verified in §3) — no anchor renames. The table lives in `src/lib/site-nav.ts` and the test asserts: every entry's target starts with `/`, its path is one of the four routes, the map has no key that is also a route, and `legacyHashTarget()` returns `null` for junk, a query, a `javascript:` string, and a malformed percent-escape (carry those cases over from `site-tabs.test.ts`).

## 7. Scope ladder

**MUST (V1, this build)**

1. `SiteHeader` + `SiteNav` in `layout.tsx`; `CommandHeader`, `TabShell`, `VerdictTape`, `verdict-tape-items`, `site-tabs` (+ test) deleted; `ReceiptsNav` removed from `/nfl`; `.receipts-mast` static; global `scroll-margin-top`.
2. `/` rebuilt: condensed `Hero`, `RunMeta`, `TodayList` with the three row kinds and the empty state exactly as §4, `SettledTable` (de-duplicated), `OverallLedger`, in-flow `AskTheDesk`, `Footer`. `revalidate = 300` kept.
3. `live-actions.ts` (server) + the `gameDate` field on `SlatePick` (the only `dashboard.ts` change).
4. `/desk` and `/experiments` routes with `metadata`, `revalidate = 300`, `JumpList`, composition as §3. `SectionHeader.index` optional and unrendered. `NflExp5` eyebrow renamed (no "Experiment No. 5" on `/experiments`).
5. `NflWeek` and `SurvivorBrief` deleted; `MlbPropPlays`, `ParlayPaperBook`, `NflExp5` each mounted exactly once site-wide.
6. `AskTheDesk` closed launcher in-flow (the ~25 lines at `AskTheDesk.tsx:335-360` only); open sheet untouched.
7. `/picks` 308 redirect + page deleted; `LegacyHashRedirect` + `site-nav.ts` + its test; `robots.ts` allow list.
8. `next.config.ts` `outputFileTracingIncludes` entries for `/`, `/desk`, `/experiments` (see §8.1) — the build is not done without them.
9. Per-route `title`/`description`; every number on every moved panel equals the same panel on the live site at the same data commit.

**SHOULD (if the MUSTs are clean before the crit)**

1. `OverallLedger` condensing (figure to rail size, drop "IN RED INK").
2. `NflExp5` example rows cut (the eyebrow rename is MUST; the cut is SHOULD).
3. Delete dead CSS: `.receipts-nav*`, `.tape-*`, `.nav-sep`, `.nav-spacer` in `globals.css`.
4. `RunMeta` hold-tone when the last run is > 26h old.
5. A text link "Ask the desk" at the end of the today section that scrolls to / opens the in-flow launcher.

**LATER (ordered)**

1. `loadTodaysPicks()` window: key on `gameDate` in a rolling window instead of `createdAt >= UTC midnight`, and drop NHL from its league filter. Pipeline-adjacent; needs its own threat pass.
2. `/nfl` settled state (graded PLAY legs with CLV once `nfl-grade` runs Tuesday) — per memory, not built.
3. `/nfl` from `force-dynamic` to `revalidate = 300` (it reads committed files; a deploy already rebuilds).
4. Export `loadParlayRetro` / `loadNflExp5` from `dashboard.ts` so `/experiments` stops paying the full Turso load for two file-backed fields.
5. A board `parlay` row in the today list.
6. `CLAUDE.md` "Dashboard" section is a description of the pre-redesign dark-navy site; rewrite after merge (docs, not code).

**NEVER (this build) — with the reason**

- A rebrand: no new fonts, palette, tokens, or a dark mode. Fraunces / Archivo / Plex Mono, bone paper, red ink only for money lost. This is an IA fix.
- New npm dependencies.
- Touching `src/lib/nfl-*`, `src/lib/agent/`, `scripts/`, `data/`, `.github/`, `prisma/`, `src/app/api/`, or `dashboard.ts` beyond the one field.
- Rewriting the `/nfl` body (941 lines) or its `receipts-*` styles; only the head/nav change.
- Rewriting `AskTheDesk` internals or the chat backend.
- Splitting `getDashboardData()` into per-route loaders.
- `force-dynamic` on any new route; `/nfl`'s existing `force-dynamic` is left as it is (a rendering-mode change to the receipts page is a separate decision).
- NFL units, stake, ROI or CLV on `/` or `/nfl` — Amendment 1.
- Reintroducing a hash-tab shell, a hamburger menu, a second site nav, or a ticker.
- Pagination / "load more" on the today list (it is never longer than the day's picks: cap 5u/day means single digits).
- Auth on `/desk`: everything there is public today; nothing secret renders. Adding a gate is a different product decision.

## 8. Rabbit holes — and the pre-decided escape

**8.1 Silent empty sections in prod (the elephant).** Server panels read `data/processed/*.json` at runtime-built paths; Vercel's file tracer cannot see them; a missing `outputFileTracingIncludes` entry ships a green build with an empty section (the config comment records it happening on `/nfl`). Moving books to `/experiments` and the desk panels to `/desk` recreates the exposure on two new routes, and `/` gains `nfl-live/*.json`. **Escape:** `next.config.ts` gets `"/": [nfl-slate.json, nfl-live/*.json, processed/*.json]`, `"/desk": [processed/*.json, nfl-live/*.json]`, `"/experiments": [processed/*.json]` (`data/processed` is 35MB, well inside the 250MB limit; `/api/*` already includes `processed/**/*`). And the orchestrator's post-deploy check (not this build): each route fetched once, one sentinel string per panel present (e.g. the Kalshi book's fill count, "THE BOARD" on `/nfl`, a PLAY leg's matchup on `/`).

**8.2 `node:fs` inside a client component.** `TodayList`, `SiteNav`, `LegacyHashRedirect` are client files. They import only types and plain props. `live-actions.ts` is imported by `page.tsx` alone. The paper books, `QuantDesk`, `VolatilityInputs`, `DeploymentGate`, `OverallLedger`, `NflExp5` stay server components composed in route files. **Escape:** the grep in §9 (`"use client"` files must not import `node:fs`, `live-actions`, or any `@/lib/*` module that does).

**8.3 `getDashboardData()` per route.** Three data-backed routes each call it once under ISR 300. Worst case is 3× today's Turso load only when all three routes are being visited (guess: from ~300 to ~900 queries/hr at peak, against a twice-daily data cycle). **Escape:** accept it; do not split the loader; LATER item 4 removes the `/experiments` share. Do not add `cache()` wrappers or a request-level memo — nothing here is called twice in one render.

**8.4 The `AskTheDesk` island.** 757 lines, its own state machine, a live backend. The temptation is to "fix the chat while we're here". **Escape:** only lines 335–360 (the closed launcher) change: `fixed bottom-4 right-4 z-[9995]` becomes an in-flow block mounted where the page places it. The open state stays fixed/full-screen; that is user-initiated and may cover content. If the launcher's `ref` wiring resists, wrap it in a positioned parent instead of touching the component's logic.

**8.5 Rewriting `/nfl`.** It is the strongest page and the one he shares. **Escape:** the diff to `nfl/page.tsx` is deletions (nav function, its call, one import) plus nothing else; `MarketNow`/`ResearchAppendix` untouched; the change is verified by the innerText check in §9.

**8.6 Touching the pipeline for a nicer list.** The today window (§0.2), NHL in the league filter, a start-time field that "should" come from the API — each is a `dashboard.ts` or agent-layer change. **Escape:** the list works with the data as given; the single additive field is the whole allowance; everything else is LATER.

**8.7 A rebrand.** The bone paper and the "no edge found" honesty *are* the brand. **Escape:** the creative-director's brief (§10) forbids new tokens; the crit rejects any.

**8.8 Redirect cleverness.** Wildcards, regex hash parsing, reflecting the hash into a path. **Escape:** a literal allowlist (§6); anything not in it is a no-op.

**8.9 The header at 390.** Fitting four links plus a wordmark invites a drawer. **Escape:** sideways-scrolling rail (existing pattern), eyebrow type, short labels. If "Experiments" still overflows, the label may shorten to "Books" — the route does not change.

## 9. Success metrics

All measured with the existing CDP harness (`scratchpad/shot.mjs`) pointed at the worktree dev server on port 3100, `ROUTES` replaced by the four routes plus the eleven legacy URLs, and these expressions added to its `Runtime.evaluate` block. Baselines are from `shots/metrics.json` (live site, 2026-09-12). Targets are for today's data (0 agent picks, 2 NFL PLAY legs).

| # | Metric | Baseline | Target | How |
|---|---|---|---|---|
| 1 | `/` document height at 390 | 10,177px | **≤ 3,500px** (+110px per live row beyond 2) | `document.documentElement.scrollHeight` |
| 2 | First live row (or the empty-state headline) on the first screen at 390 | absent | **top edge ≤ 844px** | `document.querySelector('#today li, #today [data-empty]').getBoundingClientRect().top + scrollY` |
| 3 | Live plays reachable within one tap from the first screen | 0 of 2 | **every NFL row has `a[href^="/nfl#play-"]`; every agent row has a button** | count `#today li a[href^="/nfl#play-"]` == NFL rows; `#today li button` == agent rows |
| 4 | Site nav systems per route | 3 (rail, receipts-nav, none) | **exactly 1** `nav[aria-label="Site"]` per route, 4 `<a>` children, same hrefs in the same order on all 4 routes, 0 `<button>` inside | query per route |
| 5 | Duplicate panels | 4 panels ×2 | **0**: the set of panel ids (`deployment-gate, devig-paper-book, kalshi-paper-trail, kill-room, market-feed, mlb-prop-plays, nfl-exp5, ledger, parlay-paper-book, props-desk, quant-desk-section, pead-paper-book, system-memory, volatility-inputs, today, market, research`) — each found on exactly one of the 4 routes | union of `[id]` per route; assert singleton |
| 6 | Old links resolve | `/picks` 200 with stale data | `/picks` → 308 → `/` 200; each of the 10 `/#…` URLs ends (after 1.5s) at the `location.pathname + hash` in §6; **0 responses ≥ 400** | navigate, wait, read `location.href` |
| 7 | Horizontal overflow at 390 | 0 | **`scrollWidth === clientWidth` on all 4 routes + all redirect landings** | existing metric |
| 8 | Fixed elements covering content at load | 1 (chat launcher) | **0** elements with `position: fixed` intersecting the viewport at load, on all 4 routes at 390 (exclude `nextjs-portal`) | `[...document.body.querySelectorAll('*')].filter(e => getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().height > 0).length` |
| 9 | Folio / tab numbering gone | present | **0** matches of `/\b(FOL\.|Fol\.|T[1-5]\s|Exp\.\s?\d)/` in `document.body.innerText` on every route; **0** matches of `Experiment No\. 5` on `/experiments` | regex on innerText |
| 10 | `<a>` elements on `/` | 1 | **≥ 8** | `document.querySelectorAll('a').length` |
| 11 | `/nfl` content unchanged | 471 words | `main.receipts-shell` innerText word count within **471 ± 5**, and ids `board, market, rules, ledger, errata, research` all present, and 2 `.play-stamp` elements (today's board) | innerText + queries |
| 12 | Route identity | 2 distinct titles | **4 distinct `document.title`** values; `/` title unchanged from baseline | `document.title` |
| 13 | NFL rows carry no money figures | n/a | **0** matches of `/\d(\.\d+)?u\b|ROI|CLV/` inside `#today li[data-kind="nfl"]` | innerText per row |
| 14 | `npm test` | 74 files / 1,099 green | **green**; `site-nav.test.ts` present with ≥ 8 cases; total ≥ 1,095 | `npm test` |
| 15 | `npx tsc --noEmit` | 5 errors, all `pead.test.ts` | **exactly those 5, no others** | diff against baseline output |
| 16 | Client/server split | clean | **0** `"use client"` files importing `node:fs`, `_data/live-actions`, `_data/dashboard` (non-type), or `@/lib/{kalshi,devig-paper,stocks,parlay-paper,quant-desk}` | `grep -l '"use client"' src/app -r \| xargs grep -lE 'from "(node:fs\|.*live-actions\|.*paperEngine\|.*devig-paper\|.*peadEngine\|.*parlay-paper\|.*quant-desk)'` → empty |
| 17 | Numbers unchanged | — | every figure on a moved panel equals the live site's rendering of that panel at the same data commit (spot-check: Kalshi fills, gate 2/5 + 119/200, account −0.34u / 67-52, kill rate 51.7%, board PLAY count 2) | side-by-side with `shots/tab-*-phone-p*.png` |

Guardrails: #11 and #13 are the ones that protect the receipts posture; #8 and #16 are the ones that protect the build.

## 10. Handoff briefs

### creative-director (BRIEF, then CRIT against the metrics above)

**The reader:** someone on a phone who tapped a link under a screenshot of a PLAY stamp on X. **Their first question:** "what is live right now, and is this desk honest about its record?" **The candidate lead story on `/`:** the verdict line ("The book is −7.1% ROI over 119 graded", FUNDING LOCKED stamp) immediately followed by the today list — with the list's first row, or its empty-state headline, inside the first 844px. Design the **empty state as the default state**: the 6% floor means "no edge found" is the common morning (launch day has 0 agent picks and 2 NFL plays), so the "Nothing is live · Next: …" block must read as the desk's discipline, not as a broken page.

**Solve:** (1) the one-row header at 390 with wordmark + four links; (2) the anatomy of three row kinds (game, prop, NFL leg) that reads as one list, with the NFL row visibly carrying no stake/units; (3) the hierarchy verdict → run line → list → settled → account, and how much of the nameplate survives inside a 640px lead; (4) section markers now that folio numbers are gone (the eyebrow alone, or nothing); (5) the jump list on `/desk` and `/experiments`; (6) where the in-flow chat launcher sits so it is found but never in the way. `/nfl`'s layout is the template — its `receipts-*` rhythm, stamps, and provenance lines are the house style for the rest.

**Do not change:** typefaces, tokens, the red-ink-only-for-losses rule, the three true-stamp moments (Hero funding stamp, DeploymentGate seal on `/desk`, WIN/LOSS on settled rows), anything below the head of `/nfl`, the `receipts-*` styles, the wording of Amendment 1 disclosures, or any number. No illustrations, no icons, no gradients, no dark mode.

### systems-reviewer (THREAT before the build, REVIEW after)

**Stakes:** no money moves; nothing authenticates. What can be lost is the site's one asset — the claim that every number is honest and every board immutable. A wrong or duplicated number on `/`, or a units figure beside an NFL play, is a reputational loss that screenshots forever. What can leak: nothing new (`/desk` panels are public today; the chat backend is unchanged).

**Invariants to hold:** (1) NFL rows on `/` render entry price, model %, market % only — never stake, units, ROI, CLV (`#13`). (2) Redirect targets are literals from a table; `location.hash` is never concatenated into a URL (`#6`). (3) `node:fs` and file-reading libs only in server files (`#16`). (4) Every moved panel's figures equal the live site's at the same data commit (`#17`); the today list's numbers trace to `SlatePick.*` and `PublishedLeg.*` with em-dash guards on null. (5) `/nfl` below its head is unchanged (`#11`). (6) ISR 300 on `/`, `/desk`, `/experiments`; no `force-dynamic` added. (7) `outputFileTracingIncludes` covers every file each route reads (§8.1) — enumerate the loaders' paths and check the globs. (8) The one `dashboard.ts` diff is additive: one type field, two mapper lines; nothing else in the file.

**Abuse / failure cases worth modelling:** a hash of `#javascript:…`, a 10KB hash, a malformed escape (the shim must no-op); `/picks?anything` (308 must preserve nothing, land on `/`); a board JSON string containing markup (React escapes; assert no `dangerouslySetInnerHTML` anywhere in the new files); the latest-board selector picking the wrong week when two boards exist (highest season then week — write the test with `wk01` and `wk02` fixtures); the 4h in-play window straddling an ISR revalidation (a row may show `in play` up to 5 min late — acceptable, note it); `nfl-slate.json` absent in prod (empty-state "next board" line must degrade to the no-slate copy, not throw); an in-flow chat launcher on a page where `AskTheDesk` fails to hydrate (the button is SSR'd; ensure no layout jump); the Tuesday gap where week N's legs are all past and week N+1 is unpublished (pure empty state, both "Next" lines correct).

### backend-engineer / frontend-designer

The scope ladder (§7) and §3–§6 are the engineering brief. Route table: `/` (rebuilt), `/nfl` (head/nav only), `/experiments` (new), `/desk` (new), `/picks` (308 → `/`). Files to create, modify and delete are enumerated in §3. Acceptance is §9, run against the worktree on port 3100 (stop the server when done); the crit consumes the resulting `metrics.json` and screenshots.

**Things the builders must not decide for themselves:** the four nav labels and their order; the redirect table (no additions); the definition of a live action and its 4h window; "no units on NFL rows" site-wide; the single `dashboard.ts` field; `revalidate = 300` on the three data routes and leaving `/nfl`'s rendering mode alone; the tracing includes; leaving `AskTheDesk` on `/` and `/nfl` only; leaving `/nfl` below its head untouched; no new dependencies; no CSS tokens. Everything else in the visual layer is the creative-director's call, and everything in the file layout is yours.

---

**Panel review.** Cagan: the biggest risk is not value or feasibility — it is a green build shipping empty sections (§8.1) and a screenshot of `/` contradicting `/nfl` (§4, #13); both are attacked first and cheapest with config plus deterministic checks. Moesta: the hiring moment is "tapped a receipts link on a phone, wants the record and what is live" — filmable, and the fired alternative is scrolling the thread. Dunford: the front page is for the X visitor only; the operator gets his own door one tap away — a wedge, not a page for everyone. Fried: MUST fits one session; SHOULD is droppable; NEVERs are written. Doshi: the elephant is named (8.1) and the empty state is the default state, not an edge case; what the operator is *not* doing instead is fixing the 3-day-old last run — the new `RunMeta` line makes that visible on the first screen, which is the right trade.
