# 02 — Art direction and information hierarchy (creative-director · BRIEF)

Ground truth is `docs/redesign/00-context.md`. This document is the designer's brief for the structural rebuild: what leads, what follows, what dies, and how the page must look at 390px and 1440px. It is not a rebrand. Fraunces / Archivo / IBM Plex Mono, bone paper, red ink only for money lost — all of it stays.

**What was looked at before a word was written.** All 58 screenshots in the scratchpad `shots/` folder (home ×9, tab-desk ×6, tab-props ×3, tab-experiments ×11, tab-operations ×12, nfl ×12, picks ×2) plus `metrics.json`. Code: `globals.css` (tokens, utilities, the whole `receipts-*` family and its 1023px/767px collapses), `Hero.tsx`, `SectionHeader.tsx`, `CommandHeader.tsx`, `VerdictTape.tsx`, `TabShell.tsx`, `site-tabs.ts`, `AskTheDesk.tsx` (mount and the two positioned states), `page.tsx`, `layout.tsx`, `nfl/page.tsx` lines 1–520, `NflWeek.tsx`, `MarketFeed.tsx` (state and buttons), `Footer.tsx`, `SurvivorBrief.tsx` (TonightsPlay), `DeploymentGate.tsx` head, and the data shapes in `_data/dashboard.ts`, `nfl-receipts/board.ts`, `receipts-view.ts`, `site-slate.ts`. Nothing was modified.

Where a note says *measured*, the number comes from `metrics.json` or from a named screenshot. Where it says *unmeasured*, it is a judgement the crit will check.

---

## 0. The reader, and the lead story

**Who opens this.** Someone on X who saw @NateStacksData post NFL receipts, tapped the link, on a phone, mid-scroll, with the reflex skepticism every betting account on X has earned. Their first question is not "what should I bet"; it is *"is this real, or is this another tout?"* Their second is *"what's live right now?"* Their third is *"show me the receipts."* They give the page eight seconds. The owner is the second reader: on a desktop in the morning, asking *is the agent running, what did it pick, where is the gate, how are the books doing* — and he already knows the site, so he needs speed, not persuasion.

**The lead story on `/`** is the honest verdict — record, ROI, funding state — followed immediately by every open play across leagues. Today's front page already has the verdict (`home-phone-p1.png`: "The book is −7.1% ROI over 119 graded." lands at y≈400–460, which is inside the first screen), so the lead is correct; what is wrong is everything around it. Before the verdict: a two-row telemetry header, a marquee tape, a volume line, a 6rem nameplate, two rules, a dateline, an issue number, an eyebrow and a stamp — roughly 340px of furniture. After it: an at-a-glance rail that repeats the verdict in four numbers, a "no picks resolved" line, a tab rail, "No edge found", and a second FUNDING · LOCKED stamp. Measured in that same screenshot, "locked" prints five times (header, hero stamp, status line, gate seal, gate headline) and the ROI prints twice with two different roundings (−7.1% in the headline, −7.0% in the account table, `home-phone-p2.png`). Meanwhile the two NFL plays that are actually open this weekend (NYJ at TEN, GB at MIN, `nfl-phone-p1.png`) appear nowhere on the front page, and the homepage has exactly one `<a>` element, ~3,500px down.

Garcia's verdict: one lead, said once, then the live list. Tufte's verdict: every number on the first screen prints exactly once. Both minds agree on this page.

---

## 1. What the site is, in one sentence

**NATESTACKS is a Claude-run quant desk that bets on paper in public — every pick published before the game, every result graded, every number traceable — until the record earns the right to real money.**

**The register the front page must hit for a phone reader arriving from X:** the honest ledger. The number first, and the number today is negative. That is not a weakness to design around; it is the credibility. A tout hides −7.1%; this site prints it in the first line, in red, in the number face, and then shows you what it is doing about it. Tone: dry, exact, calm — a bank statement that happens to read well. Verbs: publish, grade, pass, settle, hold. Never "crushing", never an exclamation mark, never an emoji, never a green anything that has not settled. Red ink appears exactly where money was lost and nowhere else.

**The one signature element** (protected throughout; see §4): the play card's disagreement figure — the model bar over the market bar on one scale, the signed `+16.8 pp` in ledger blue, the PLAY stamp beside it. That glyph *is* the thesis: the desk bets the disagreement and is judged by the close. Everything that competes with it for loudness — the giant `−0.34u`, the 7.7% kill-rate display figure, the second funding stamp, the gradient fills under the equity curves — is demoted below.

One observation outside this round's scope, recorded so it is not lost: the front door (`/api/og/picks`) is a dark navy card with neon cyan/lime/pink, and the page it opens is bone paper and warm ink. The first tap is a brand break. Not this round (the context doc freezes the OG route), but it belongs on the next list.

---

## 2. The shared header

One `<header>` component, rendered on every route, identical on every route. It replaces `CommandHeader` + `VerdictTape` + `TabShell`'s rail on `/`, and `MastheadStrip` + `ReceiptsNav` on `/nfl`.

### Anatomy

```
1440px — one row, 44px tall, 1120px shell, sticky top:0
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ NATESTACKS*   TODAY   RECEIPTS   EXPERIMENTS   DESK      RAN 3D AGO · NEXT SAT 18:30 ET   PAPER · LOCKED │
│               ‾‾‾‾‾                                                                        │
└──────────────────────────────── 3px double rule (rule-strong) ─────────────────────────────┘

390px — two rows, ≤68px total, sticky top:0
┌──────────────────────────────────────────┐
│ NATESTACKS*                PAPER · LOCKED │  row 1 · 36px
│ TODAY   RECEIPTS   EXPERIMENTS   DESK     │  row 2 · 32px
│ ‾‾‾‾‾                                     │
└────────────── 3px double rule ────────────┘
```

- **Wordmark**: `NATESTACKS` in `font-display` 900 at 0.875rem, tracking −0.015em, with the red asterisk. The asterisk is the one permitted non-money red on the site — it is the brand's footnote mark, one glyph, once per page. It links to `/`.
- **The link set — exactly four real `<a href>`**: `Today` → `/`, `Receipts` → `/nfl`, `Experiments` → `/experiments`, `Desk` → `/desk`. Set as `.eyebrow` (mono, uppercase). At 390 the four labels total ~281px at 0.65rem with 0.14em tracking (estimated by character count against Plex Mono's 0.6em advance — unmeasured in the browser; the crit checks it), so the row does **not** scroll and does **not** wrap. Tracking comes down at 390, size does not (the `/nfl` mast already uses this move).
- **Active route**: ink color, 600 weight, 2px ink underline on the link's own bottom edge (the existing tab-rail treatment), `aria-current="page"`. Inactive links are `--ink-2`. Hover: ink + 1px underline. No animation.
- **The status telemetry that survives**: the funding state, everywhere, as one token: `PAPER · LOCKED` in `--hold` (becomes `LIVE · FUNDED` in `--win` if `paperTrial.ready` ever flips). "Mode" and "funding" were two tokens saying one thing; they merge. `RAN 3D AGO · NEXT SAT 18:30 ET` (from `status.lastAgentRunAt` / `nextScheduledRunUtc`) prints in the header at ≥1024px only, as `--ink-3` agate before the funding token. Below 1024px it leaves the header and lives in content: the `/` board's meta line and the `/desk` status line (§3, §5). `DAY 030` moves to the `/` verdict eyebrow. The pulsing dot goes: a dot is color-only information, and the words carry it.
- **Sticky**: yes, at every width, `position: sticky; top: 0; z-index: 30`, solid `--paper`, bottom edge is the 3px double rule (`rule-double`). It does not react to scroll: no shadow, no compression, no hide-on-scroll. Nothing else on any page is sticky (the tab rail, the tape, the `/nfl` section rail all die). `[id] { scroll-margin-top }` becomes 84px at 390 and 60px at ≥768.
- **Height budget**: ≤44px at 1440; ≤68px at 390. Today's sticky chrome at 390 is roughly 140px (two-row CommandHeader ≈70 + tape ≈30 + tab rail ≈40, `home-phone-p1.png`) — this halves it.

### Footer (shared, every route)

Double rule; the same four links repeated as text links; `NATESTACKS · The Paper Trial · pressed {generatedAt} ET`; `Model output · not betting advice · 1-800-GAMBLER`; the colophon line. `/nfl` keeps its own extra colophon sentence about immutable boards. The footer is where the reader who scrolled to the bottom finds the way out, so the links are not optional.

### Legacy hashes

`/#tonight`, `/#the-desk`, `/#props`, `/#experiments`, `/#operations`, `/#nfl-week` are in old X posts. Map: `#tonight → /#board`, `#the-desk → /desk#quant-desk`, `#props → /desk#props`, `#experiments → /experiments`, `#operations → /desk#market`, `#nfl-week → /nfl#market-now` (give `MarketNow` that id if it lacks one). A hash cannot be redirected server-side, so a tiny client script on `/` reads `location.hash` on mount and `location.replace()`s the mapped route; with no JS the reader lands at the top of `/`, which is a sane landing. `/picks` is a real route and gets a real redirect to `/`.

---

## 3. `/` — Today

### The hierarchy ladder

| Tier | Section (id) | What it is | 390px height budget |
|---|---|---|---|
| **LEAD** | the verdict (`#verdict`, the page `<h1>`) | record · ROI · graded, then "Real money stays locked." | ≤200px |
| **SECOND READ** | THE BOARD (`#board`) | every open play, all leagues, as play cards | 280px per play; 120px when empty |
| BODY | THE PLAY (`#the-play`) | the top agent pick's thesis and what kills it — only when an agent pick is open | ≤320px, or absent |
| BODY | SETTLED (`#settled`) | last 36h graded rows with WIN/LOSS stamp-rows; one line when none | ≤260px |
| BODY | THE ACCOUNT (`#account`) | by-league table, streaks, best/worst | ≤480px |
| BODY | THE GATE (`#gate`) | the funding seal (once), sample meter, five ML criteria | ≤520px |
| AGATE | ASK THE DESK (`#ask`) | inline chat section (§7) | ≤160px closed |
| AGATE | footer | links, colophon | ≤160px |
| CUT | nameplate, tape, at-a-glance rail, hero stamp, "No edge found" folio, the giant `−0.34u`, prop track, NflWeek, MlbPropPlays, ParlayPaperBook, NflExp5 | see §6 | — |

**Target height for `/` at 390px: ≤ 2,800px with today's data (2 NFL plays open, 0 agent picks, nothing settled in 36h). Hard cap 3,800px on a five-play night with a story.** Measured today: 10,177px. At 1440: ≤ 2,400px today (measured 7,181).

### The first screen at 390px (844px tall, in order)

1. **Header** (68px).
2. **Eyebrow** (`.eyebrow`, `--ink-2`): `THE PAPER TRIAL · DAY 30 · SAT SEP 12 · NBA MLB WNBA NFL`. This absorbs the volume line, the dateline, the issue number and "The trial to date · day 30". One line. If it wraps at 390, drop the league list first.
3. **The verdict — the `<h1>`, two lines:**
   ```
   67–52 · −7.1% ROI · 119 graded        ← line 1: .num, 1.5rem at 390 / 2.25rem at 1440, 600 weight
   Real money stays locked.               ← line 2: .headline, clamp(1.625rem, 5.6vw, 2.75rem)
   ```
   The number first, in the number face; the verdict in the word face. `−7.1%` is `--loss` (money lost); the record and the count are ink; "locked" is ink — locked is a hold, not a loss, and the word carries it. Source: `paperTrial.wins/losses/pushes`, `paperTrial.roi`, `paperTrial.totalGraded`, `paperTrial.mlReady`. When `mlReady`, line 2 reads "Real money is unlocked." with the seal in `--win` down at the gate. When `totalGraded === 0`, line 1 is "No picks graded yet".
4. **One agate line** under the verdict: `2 of 5 funding criteria clear → the gate` — a real link to `#gate`. Net units, the slate count and the tonight count do not print here: net units is the same fact as ROI (both from `pnl`), the slate count is a market-feed statistic, and "tonight" is the board itself.
5. **Section head** (the `/nfl` pattern, §4): title `THE BOARD`, meta `2 OPEN PLAYS · NFL WEEK 1 · AGENT LAST RAN 3D AGO · NEXT RUN SAT 18:30 ET`. At ≥1024 the meta ends with `THE RECEIPTS →` as a link when any NFL row is present; at 390 that link sits at the end of the section instead (below the cards) so the first card stays in the first screen.
6. **The first play card**, fully visible with its stamp and its disagreement figure, by y≈840. This is the falsifiable fold test (§10, criterion 1).

Everything below the first card is the second screen and beyond, in the order of the ladder above.

### A row of the board — it is the `/nfl` play card

The board row **is** `.play-card` from `/nfl`, reused across leagues. It already has the 1023px and 767px collapses, the stamp, the team stack and the rail. One unit, two viewports, no new CSS. The only additions are a league tag in the head and a source line in the foot.

```
390px (the existing <1024 grid: head/stamp · team · rail · foot)
┌─────────────────────────────────────────────┐
│▌ NFL · SUN SEP 13 · 1:00 PM ET       [PLAY] │  head: league eyebrow + kickoff · stamp-true, --blue
│▌ NYJ  at  TEN                               │  team-stack: selected in ink 2.75rem, opponent ink-2 1.25rem
│▌ MODEL  ████████████░░░░░░  63.3%           │  rail-row, is-model --blue
│▌ MARKET ████████░░░░░░░░░░  46.5%           │  rail-row, is-market
│▌ ───────────────────────────────────────    │
│▌ DISAGREEMENT               +16.8 pp        │  rail-gap, --blue, the signature
│▌ ───────────────────────────────────────    │
│▌ ENTRY +106 @ FANDUEL · 2026-09-08 14:09Z   │  entry-line
│▌ BOARD WK 1 · PUBLISHED TUE · RECEIPTS →    │  NEW source line: where it came from, links /nfl#play-{legId}
└─────────────────────────────────────────────┘

An agent pick (NBA/MLB/WNBA moneyline):
│▌ MLB · TONIGHT 7:41 PM ET             [PLAY] │
│▌ Rangers  at  Mariners                       │  selection nickname first (shortName()), opponent second
│▌ MODEL / MARKET rails … DISAGREEMENT +5.7 pp │  modelProb − marketProb, printed as pp
│▌ ENTRY +136 · 0.25u                           │  price + stake (agent picks are the funded-track book; stake is allowed)
│▌ ANALYST RUN SAT 18:30 ET · SURVIVED THE CRITIC · OPEN AUTOPSY → │  links #the-play / opens PickAutopsy

A prop:
│▌ N. Reid  OVER 13.5 pts                      │  team-sel = player, team-opp = the line
│▌ MIN vs SAS                                  │  entry-line carries the matchup
```

Row rules:
- Fields, in this order: **league · matchup · side · price · disagreement · kickoff · where it came from**. All seven print on every row, at every width.
- The disagreement is arithmetic on the two printed percentages (`/nfl` rule 2), printed as `+N.N pp`. The site currently says "5.7% edge" on the homepage and "+16.8 pp" on `/nfl` for the same quantity; from now on it is pp everywhere and the word "edge" is reserved for the doctrine's price test.
- NFL rows print entry price and disagreement and **never** a stake, a unit or a return, on any page (pre-registration Amendment 1 applies to the play wherever it is shown, not just to `/nfl`). Agent rows may print the stake.
- Order: by kickoff ascending, then by league. No ranking by edge on the front page — every open play is equal.
- The whole card is one link (`<a>` around the card, accessible name = "{selection} at {opponent}, {league}"); no nested interactive elements. The `[PLAY]` stamp is `stamp-true` at ≥1024 and `stamp-row` scale at 390 if the true stamp pushes the card past 300px — the crit measures.
- The doctrine notes list from `/nfl` does not print on `/`; the source line's link is where the notes live.

### The empty state — say it once, then what's next

When no play is open (kickoff > now for NFL legs; `data.picks.games` and `data.picks.props` empty):

```
THE BOARD
0 OPEN PLAYS · AGENT LAST RAN 3D AGO
──────────────────────────────────────────
Nothing is open. The next agent run is Sat 18:30 ET; the NFL board publishes at least 12h before the first kickoff.
Last settled: Thu Sep 10 · 1–1 · −0.06u → settled
```

Two lines, `.prose`, then the section ends. No "No edge found" headline, no "Discipline beats action" paragraph, no CAPITAL HELD tag in red (nothing was lost). The "what's next" facts come from `status.nextScheduledRunUtc` and the ledger; do not invent a publishing schedule beyond the 12h rule the board already states. (The "Last settled" figures above are illustrative of the shape, not data — print whatever the ledger holds.)

### Where the link to the receipts sits

Three places, no more: the header (`Receipts`, always); the source line of every NFL card (`RECEIPTS →`, deep link to `/nfl#play-{legId}`); and the end of THE BOARD section at 390 / the section meta at ≥1024 (`THE RECEIPTS →`) whenever an NFL row is present. The `NflWeek` paragraph link dies with `NflWeek`.

### The rest of the page, briefly

- **THE PLAY** (`#the-play`): only when an agent pick is open. The current `TonightsPlay` story minus its `SectionHeader` and minus the four rail figures (they are on the card now): the thesis as a `.deck` pull-quote capped at 280 characters, "What kills it" as one `.prose` line with the label in `--ink-2` (not red — nothing was lost), and the `Open autopsy` control. Multiple agent picks: the highest-edge one gets the story; the others are cards only.
- **SETTLED** (`#settled`): the existing `SettledTable` (stamp-row WIN/LOSS, ±units), most recent ≤5 graded across leagues, then `THE ACCOUNT ↓`. NFL settled legs print CLV in pp with BEAT / MISSED stamp-rows, never units. When none: one `.prose` line, "No picks settled in the last 36 hours."
- **THE ACCOUNT** (`#account`): the by-league table (league · record · units · ROI) in `.ledger-table` — at 390 the ROI column drops and staked drops (derivable, agate); streak and peak/trough as one agate line; best and worst pick as two agate lines. The giant `−0.34u` figure is cut (it is the headline's fact, restated). The ROI here must print the same string as the verdict: `−7.1%`, one rounding path.
- **THE GATE** (`#gate`): the seal (`stamp-true`, `StampIn`, **once**, `--hold` when locked — today the gate's seal is `--loss` red and the hero's is ochre, `home-phone-p1.png`; locked is a hold, so `--hold` everywhere), the 119/200 sample meter, the five ML criteria as verdict · criterion · current rows. The prop track (0/3, n=4) moves to `/desk#props`. Section title `THE FUNDING GATE`, meta `2 OF 5 CRITERIA CLEAR · TRIAL TO DATE · SINCE MAY 6`.

At 1440 the page is one column in the 1120px `/nfl` shell. The Hero's 7/5 grid and the 1280px container go. Play cards take their full three-area grid (team | rail | stamp).

---

## 4. `/nfl` as the template

The receipts page is the strongest page because it obeys three laws the rest of the site breaks: prose is Archivo at a readable size, every section is a caps serif title with a meta line under a hairline, and content never scrolls sideways. Promote its vocabulary to the whole site.

### Elements that become the shared vocabulary

| `/nfl` element | Class(es) | Becomes, site-wide |
|---|---|---|
| The play card | `.play-card`, `.play-card-head`, `.play-card-stamp`, `.team-stack`, `.team-sel/.team-conn/.team-opp`, `.rail`, `.rail-row`, `.rail-track`, `.rail-fill.is-model/.is-market`, `.rail-val`, `.rail-gap`, `.play-card-foot`, `.entry-line` | **The play** — the unit of every open action on `/` and `/nfl`. Its disagreement figure is the site's signature. |
| The section rhythm | `.receipts-section` (margin-top 2.5rem), `.section-head` (padding-bottom .55rem, 1px `rule-strong`), `.headline.section-title` (1.875rem / 1.5rem at 767), `.eyebrow.section-meta` | **Every section on every route.** Replaces `SectionHeader` (folio + eyebrow + double rule + 3xl–5xl title + subtitle + status tag). The pairing is title-then-meta; the meta carries counts, dates and status, so the status tag and the subtitle are absorbed. |
| Page head | `.receipts-head`, `.receipts-h1` (2.5rem / 1.875rem), `.standfirst` (Archivo .9375rem, 68ch) | **Every route's `<h1>` + standfirst.** `/` uses the two-line verdict as its `<h1>` instead of a name; `/nfl`, `/experiments`, `/desk` use a name. |
| Prose | `.prose` (Archivo .9375rem/1.6, `--ink-2`, 68ch), `.prose strong`, `.prose .num`, `.prose a` (blue, underlined) | **Every paragraph on the site.** The mono paragraphs in `TonightsPlay`, `NflWeek`, `MarketFeed` and the caps run-on disclaimers on the book cards all become `.prose`. |
| The disclosure block | `.rules-panel` ("READ THIS FIRST — NO ROI CLAIM IS MADE HERE": a `panel-dim`, one red eyebrow head, `.prose` body) | **The one disclosure per page.** `/experiments` gets one at the bottom (replacing five caps disclaimers); `/` gets none (the gate section is the disclosure); `/desk` gets one under the quant desk. The red eyebrow head is the second permitted non-money red — it is a warning about money, capped at one per page. |
| The empty publication | `.empty-board`, `.empty-lede`, `.empty-sub` | The pattern for "nothing happened, on time" — used on `/` only if the board is empty *and* the desk is mid-season; otherwise the two-line empty state in §3 (the stamp is too loud for a Saturday with nothing on). |
| The stacked-row table | the `.pass-table` / `.market-table` `grid-template-areas` collapse at ≤1023px with `.cell-label` inline column labels | **Every table below 1024px** (§8). |
| The scoped type scale | `.receipts .eyebrow` .75rem/.18em, `.receipts .tag` .8125rem, `.receipts .ledger-table th` .75rem | **The site's type scale.** The global .65rem/.22em eyebrow was the literal "hard to read" the `/nfl` build fixed. Cheapest honest mechanism: put the `receipts` class on every route's root so the scoped rules apply everywhere (the builder may instead lift the values into the globals; the result must be identical). |
| The market table | `MarketNow` + `.market-table` | Stays on `/nfl` as is; `/desk`'s "The market" adopts its row anatomy for NFL rows. |

### What goes away on `/nfl`

- `MastheadStrip` (`RESEARCH LAB · NO ROI CLAIM · NOT BETTING ADVICE` + `2026 · WK 1`): replaced by the shared header. The three tokens print **once**, in the page-head eyebrow: `NFL EXPERIMENT NO. 5 · RESEARCH LAB · NO ROI CLAIM · NOT BETTING ADVICE`. `NOT BETTING ADVICE` also lives in every footer. The week/season is already in THE BOARD's meta line.
- `ReceiptsNav` (↩ NateStacks | Tonight · The Desk · Props · Experiments · Operations | The receipts · Research ↓): replaced by the shared header. The `Research ↓` in-page jump survives as the existing "Part two" link in the `.halves` paragraph.
- `AskTheDesk scope="nfl"` moves from the floating island to the inline `#ask` section before the footer (§7).
- Nothing else. The board, passed games, market now, rules, ledger, errata and research appendix keep their content, their ids and their `receipts-*` styles byte for byte. `--win` green still appears zero times above `#research` until a leg settles beat-close.

---

## 5. `/experiments` and `/desk` — the operator pages

Operator pages are allowed to be denser and longer than `/`. They are not allowed to be five copies of the same disclaimer or a table of zeros.

### `/experiments`

`<h1>` `The experiments`, standfirst: "Four independent $10k paper books testing published market inefficiencies, and the NFL receipts. Each book compresses to a card; charts print at five settles." Meta under the section head: `4 BOOKS · $10K EACH · UPDATED {generatedAt}`.

**The ladder.** LEAD: the book whose status changed most recently (unmeasured which; order by `equityCurve` last-point date descending — today that puts the Devig book first, `tab-experiments-phone-p5.png`). SECOND: the other three live books. BODY: the NFL pointer card. AGATE: the page-level disclosure. CUT: the per-card caps disclaimers, the parlay book's second (retrospective) equity curve above the fold, `NflExp5`'s 16 sample rows.

**The book card — one anatomy, five times:**

```
┌ .panel ───────────────────────────────────────────────┐
│ Kalshi favorite-longshot            PAPER · LIVE  Exp. 1 │  headline 1.25rem · status .tag --blue · number as --ink-3 agate, LAST
│ Buys heavily-favored contracts (0.80–0.95, ≤60d)…       │  one .prose line (the existing description, ≤ 160 chars)
│ ┌──────────┬──────────┬──────────┬──────────┐          │
│ │ EQUITY   │ REALIZED │ RECORD   │ VERDICT  │          │  exactly 4 stat cells, .num 1.25rem, label .eyebrow
│ │ $9,543.80│ −$456.20 │ 341–57   │ −$1,299… │          │  the 4th is the book's verdict metric (below)
│ └──────────┴──────────┴──────────┴──────────┘          │
│ EQUITY CURVE                                            │  120px tall at 390, 160px at 1440 (spec §8)
│ ╭─╮        ___/‾‾‾                                       │  1.5px line, --win/--loss by sign, dashed $10k baseline, NO area fill
│ ▸ 398 settled · last: GPT-6 before Nov 1 · WON +$17.36 · Sep 9 │  <details><summary> — closed by default at every width
└──────────────────────────────────────────────────────────┘
```

- The name leads; the experiment number is the last thing on the line, in `--ink-3` agate ("Exp. 1", "Exp. 2", "Exp. 3", "Exp. 4b"). Today the number leads ("Exp. No. 1 — Kalshi favorite-longshot, $10k paper"); flip it. "$10k paper" moves to the page meta since it is true of all four.
- The verdict cell per book: Kalshi → filled-only P&L (the fill-verification finding is the experiment); Devig → yield; Post-earnings drift → avg excess vs SPY with the `accumulating 38/40` gate note; Parlay 4b → record. Every other figure the cards print today (verified fill rate, win% filled/missed, open exposure, etc.) folds into the existing `VERDICT DIAGNOSTICS` unfold.
- The settled list (15 rows today, `tab-experiments-phone-p2..6.png`) and the open positions fold behind `<details>`, closed by default at **every** width — one mechanism, one behaviour; a desktop reader clicks once. The summary line carries the count and the last settle, so the fold hides detail, not news.
- The parlay book's "Retrospective · 30-day backtest · quarantined" sub-book, with its second curve, folds entirely into a `<details>` titled `Retrospective backtest (quarantined, not live) ↓`.
- The equity curve prints only when the book has ≥5 settles. The parlay book today draws a one-step chart for one settle (`tab-experiments-phone-p6.png`); that is a chart of nothing.
- **The NFL card** replaces `NflExp5`: title `NFL — the receipts`, tag `LIVE ON /NFL`, number `Exp. 5`; two `.prose` lines: "Live season: 2 plays open · 0 / 150 graded · the verdict metric is CLV against a sharp close; no return is claimed." and "Backtest, in-sample 2019–24, 2025 holdout negative: 189–120–1 ML · 672–400–7 props · 103–444 parlays."; two links, `/nfl` and `/nfl#research`. No curve, no stat cells, no sample rows — every number on it already lives on `/nfl` under its caveats.
- **One disclosure block** at the bottom of the page (`.rules-panel` pattern): the fill-assumption paragraph, the taker/maker notes, "simulated, not financial advice". Five copies become one.

**Target at 390: ≤ 3,000px** (measured today 11,991). Card ≈ 420px × 4 + NFL card 200 + heads and footer.

### `/desk`

`<h1>` `The desk`, standfirst: "The agent's operating floor: the live model-edge book, the critic's record, the market it bets against, its standing rules, and the injury wire." Status line under the head (this is where the header telemetry lands at <1024): `MODE PAPER · LAST RUN 3D AGO · NEXT SAT 18:30 ET · 63 RUNS / 14D`.

**The ladder.** LEAD: the quant desk's rail status — today "DRAWDOWN RAIL ENGAGED · EQUITY 21.9% BELOW PEAK · NO NEW PLAYS" (`tab-desk-phone-p2.png`) is the operator's headline, and it stays a red band because money was lost. SECOND: the kill room funnel. BODY: props, the market, standing rules. AGATE: the injury wire, the footer. CUT: the kill taxonomy, the all-zero prosecution log, the 7.7% display figure, the second `NflWeek`.

1. **THE QUANT DESK** (`#quant-desk`): the same book card as `/experiments` (4 cells: equity, CLV beat-rate, record, open exposure; curve; folded settled list). The rail-engaged band prints above the cells when engaged. The "In the lineage of Benter, Benham, and Bloom" subtitle is cut — the method line on the card says what it does.
2. **THE KILL ROOM** (`#kill-room`): keep the funnel (RAW 13 → GRADED 13 → SURVIVED 12 → SHIPPED 12 with the kept-% labels) — that is data-ink. The kill rate is one of four stat cells (kill rate 14d · trial kill rate 51.7% · avg CLV 14d · parse health), not a 6rem display figure. **Cut the kill taxonomy** (six categories, every count 0, footnoted "not yet persisted per pick", `tab-desk-phone-p3.png`) until a run persists a category; render it conditionally on any non-zero count. **Cut prosecution-log rows with raw = 0**; if every row is zero print one line: "No raw ideas in the last 14 days across 8 runs." Red zeros are not losses.
3. **PROPS** (`#props`): the props desk compressed: 4 cells (record · units · win rate · pending), tonight's survivors as play cards if any, the prop funding track (0/3) as three agate rows, `MlbPropPlays` once. When everything is empty (today, `tab-props-phone-p1.png`), the section is the 4 cells and one line.
4. **THE MARKET** (`#market`, the renamed `MarketFeed`): decided — **a summary with an unfold, grouped by league, collapsed rows at 390.**
   - Section meta: `65 GAMES · MLB 24 · NFL 16 · WNBA 8 · NBA 17 · CONSENSUS MEDIAN · REFRESHED {time}` (counts from the data, not typed).
   - Controls at 390: one league row (ALL · NBA · MLB · NFL · WNBA) and one toggle row (`Desk rows only`, on by default — this merges SCOPE DESK/FULL BOARD with PICKS ONLY, which were two subsets of one idea; `Sort by edge`, off by default). Seven controls, two rows, each a real `<button aria-pressed>`, ≥36px tall. At ≥1024 the current three groups may return as chip rows.
   - Rows at 390: the `/nfl` `.market-table` stacked-row anatomy — line 1 `LEAGUE · Away @ Home · 7:41 PM`, line 2 `ML +136 / −162 · SPRD −1.5 · +11 pp ▮▮▮`. ~56px per row. Grouped under league day-bands (`.day-band`). The first 20 rows print; then `Unfold 45 more ↓` (`<details>`). At ≥1024 the full table with sticky `<thead>`.
   - Rendering rules from the pixels: when either side's price is missing the row prints `—` for edge and no diverge glyph (`tab-operations-phone-p3..4.png` show `+58 pp` and `+61 pp` against a 2% market — a missing price rendered as a number). When the same matchup appears twice (Guardians @ Orioles at 18:36 and 18:37, Twins @ Tigers at 13:11 and 18:41, `tab-operations-phone-p1..2.png`) print the date beside the time so a reader can tell a doubleheader from a duplicate. Both are rendering decisions inside the component; the data is untouched.
5. **STANDING RULES** (`#memory`): the dream transcript stays as `.prose` (it is the operator's weekly memo). The 45 rules are set as `.prose` at .875rem, not as 1.125rem serif paragraphs (`tab-operations-phone-p6..8.png`); each rule's line 1 is one eyebrow (`§05 · QUANT-DESK-DOCTRINE · ALL · NEW · W 0.70 · UPDATED 5D`), the weight bar is cut (a four-character number says it). The five `isFresh` rules print open; the rest fold by scope. The scope chips read `ALL (12) · ALL (19) · MLB (20) · NBA (2) · WNBA (4)` today — two chips named ALL is a labelling bug; the first must carry its real name (probably the fresh filter).
6. **INJURY WIRE** (`#injuries`): stays collapsed. Title `INJURY WIRE`, meta `485 LISTED · 115 TEAMS ON TODAY'S SLATE · 8 NBA · 91 MLB · 43 NHL · 343 NFL`. The "485 active risks" headline is cut — a count is not a headline.
7. Footer.

**Target at 390: ≤ 4,500px** (measured today: operations 14,920 + desk 5,536 + props 1,896 = 22,352 across the three tabs that merge here). The operator pays for density with scroll; he does not pay for zeros.

---

## 6. Kill list

Each thing that dies, and the label that replaces it where one is still needed.

| Dies | Why (measured where possible) | Replacement |
|---|---|---|
| Folio numbers (`FOL. 02 … 11`, `Fol. —`, `No. 030`) | Read in the order 02, 03, 04, 11, 09, Exp. 4, Exp. 5 on Tonight; furniture that numbers nothing a reader can use | None. Section title + meta carry identity. Day number → the `/` verdict eyebrow (`DAY 30`). |
| `T1–T5` tab numbers and `TabShell` | Three nav systems on three routes | The four header links. |
| `VerdictTape` | One item, repeated three times, animating above the fold | Its one fact (next run) → the board meta on `/` and the `/desk` status line. |
| `CommandHeader` (MODE · DAY · LAST RUN · NEXT · FUNDING) | Wraps to two rows at 390; five tokens, two facts | `PAPER · LOCKED` in the header; run telemetry per §2. |
| Hero nameplate (volume line, 6rem "The Paper Trial", dateline, tagline, issue number) | ~340px before the verdict at 390 | The eyebrow `THE PAPER TRIAL · DAY 30 · SAT SEP 12 · …`; the `<h1>` is the verdict. |
| Hero FUNDING stamp | The seal prints twice in 1,400px; "locked" prints five times | The seal at the gate, once, `--hold`. |
| Hero "At a glance" rail (Net · Gate · Tonight · Slate) | Net = ROI restated; Tonight = the board; Slate = a feed count | One agate link: `2 of 5 funding criteria clear → the gate`. |
| Hero STATUS / TONIGHT / LAST NIGHT lines | Three lines restating the verdict, the board, and settled | Folded into the verdict, the board, and SETTLED. |
| "No edge found." folio + "Discipline beats action" + `CAPITAL HELD` (red) | Empty-state theater; red for no loss | The two-line empty state in §3. |
| "The account, in units" giant `−0.34u` + `IN RED INK` tag | Restates the headline at 6rem | The by-league table and one agate line. |
| ROI `−7.0%` in the account (`home-phone-p2.png`) vs `−7.1%` in the headline | Two roundings of one number | One string, one rounding path. |
| `NflWeek` ×2 ("Football, at the sharp number") | Same `nfl-slate.json` as `/nfl` Market Now; `MarketFeed` already carries NFL rows; its FAIR/SPREAD/TOTAL clip at 390 (`home-phone-p3.png`); its one job was a link to `/nfl` | The header's `Receipts` link and the NFL play cards on `/`. |
| `MlbPropPlays` ×2, `ParlayPaperBook` ×2 | Mounted on two tabs each | Once each: `/desk#props`, `/experiments`. |
| `NflExp5` ×2 | A third copy of `/nfl` Part Two (672–400–7, 103–444, +39.0% all print there too); 16 sample rows on the front page | The `NFL — the receipts` card on `/experiments`. |
| The two things called "Experiment 5" | The homepage card and the live receipts share a name | "NFL Experiment No. 5" survives **only** as `/nfl`'s pre-registered page eyebrow. The `/experiments` card is `NFL — the receipts · Exp. 5 · live on /nfl`. |
| `MarketFeed`'s name "The board · consensus median" / "Tonight's desk slate" | "Board" must mean one thing: published plays | `THE MARKET`. |
| Kill taxonomy (6 rows × 0), prosecution log rows of 0/0/— | Tables of nothing, in red | Conditional render; one line when empty. |
| The 7.7% kill-rate display figure | A 6rem number for a 14-day window whose canonical value (51.7%) is one line below | A stat cell. |
| Per-book caps disclaimers ×5 on `/experiments` | The same ~40 words five times | One `.rules-panel` disclosure per page. |
| Equity-curve gradient fills | Decoration under the data line | 1.5px line + dashed baseline. |
| The prop funding track on `/` | n = 4 | `/desk#props`, as three agate rows. |
| `/picks` ("The screen", dated 2026-05-06) | Four months stale, no nav, still live | Redirect to `/`. |
| Red on: `CAPITAL HELD`, the gate's locked seal, `IN RED INK`, taxonomy zeros, `0 ALLOCATED`, "The Sharp" byline, "What kills it" | Red ink is reserved for money lost | `--hold` for held/locked, `--ink-2` for labels. Exceptions, named: the wordmark asterisk (1 glyph) and one `.rules-panel` head per page. |
| `Tally` (count-up numbers), `sheet-rise` on tab switch | A number that is wrong for 300ms; tabs are gone | Nothing. |
| `AskTheDesk`'s fixed tab below 1024px | Covers the GATE row on `/` and the GB@MIN PLAY stamp on `/nfl` (measured, `home-phone-p1.png`, `nfl-phone-p1.png`) | §7. |
| `SectionHeader.tsx`, `TabShell.tsx`, `VerdictTape.tsx`, `verdict-tape-items.ts`, `CommandHeader.tsx`, `NflWeek.tsx`, `NflExp5.tsx` | Superseded | Delete once no importer remains; `site-tabs.ts` and its test survive only if the legacy-hash map reuses them, else delete both. |

---

## 7. The chat island (`AskTheDesk`)

**Decision: below 1024px the chat is an inline section (`#ask`) at the end of every page's main content, before the footer — no fixed positioning at all. At ≥1024px it may remain the fixed bottom-right tab, because the 1120px shell leaves ≥160px of empty margin on each side at 1440 and the tab covers nothing.**

Why: the measured defects are both "the closed tab covers content" — the GATE row on `/` and a PLAY stamp on `/nfl` at 390. On a 390px screen there is no bottom-right that is not content, and a full-width bottom bar would permanently spend 5% of every screen on chrome that is louder than the page — Garcia's veto. A route (`/ask`) would orphan the chat from the page it consults. Inline, the closed state costs ≤160px once, at the bottom, where the reader who has read the page is the one who wants to ask about it. The footer's `Ask the desk` link scrolls to it.

Anatomy of the inline closed state at 390: section head `ASK THE DESK` with meta `THE SHARP · LIVE PULL ON EVERY ANSWER`; the three starters as buttons in a row (wrapping); the input with its send control. Opening (a starter or a submit) grows the transcript **in flow** — the existing full-screen `fixed inset-0` dialog is kept only for the actively-opened state at <640px if the builder finds in-flow scrolling of a long transcript worse; the crit will check that the closed state never overlaps anything and that the open state is dismissible. Type inside the chat comes up to the site floor: the `0.52rem`/`0.55rem` bylines (8.3–8.8px) become `0.6875rem`. "The Sharp" byline is `--ink`, not red; the PASS verdict inside a reply stays red only when the reply is telling the reader not to spend money — that is the one in-chat red.

---

## 8. Type scale, spacing, motion budget, and tables at 390

Everything below uses existing tokens and classes; no new fonts, no new colors.

### Type scale (390 / 1440)

| Role | Class | 390px | 1440px | Notes |
|---|---|---|---|---|
| Page `<h1>` (name) | `.headline.receipts-h1` | 1.875rem | 2.5rem | `/nfl`'s values; "The Paper Trial" drops from 2.3–6rem. |
| `/` verdict line 1 | `.num` 600 | 1.5rem | 2.25rem | tabular figures; `−7.1%` in `--loss`. |
| `/` verdict line 2 | `.headline` | clamp(1.625rem, 5.6vw, 2.75rem) | — | ≤ 24ch per line at 390; must fit in 2 lines. |
| Section title | `.headline.section-title` | 1.5rem | 1.875rem | caps, as on `/nfl`. |
| Section meta / eyebrow | `.eyebrow` | 0.6875rem / 0.14em | 0.75rem / 0.18em | the `.receipts` scale; **11px is the floor for any text on the site**. |
| Card name (book card) | `.headline` | 1.125rem | 1.25rem | |
| Team stack | `.team-sel` / `.team-opp` | existing (2.75rem / 1.25rem) | existing (clamp 2.75–4.5rem / 2rem) | untouched. |
| Disagreement figure | `.num-display.rail-gap` | existing clamp | existing | the only `num-display` on `/` and `/nfl`. |
| Stat cell figure | `.num` | 1.125rem | 1.25rem | book cards, kill room, props. |
| Row figures | `.num` | 0.875rem | 0.9375rem | prices, pp, units. |
| Prose / standfirst | `.prose`, `.standfirst` | 0.9375rem / 1.6 | same | 68ch max; at 390 the measure is the gutter (~42ch). |
| Agate | `.eyebrow`, `.tag` | 0.6875rem | 0.75rem / 0.8125rem | never smaller. |

`num-display` is rationed to three uses site-wide: the play card's disagreement, a book card's equity cell, and the kill-room funnel counts. Nothing else.

### Spacing

- Shell: `max-width 1120px`; gutters 1.25rem at <768, 2rem at ≥768 (the `/nfl` shell). The homepage's 1280px container and 5/10 gutters go.
- Sections: `.receipts-section` margin-top 2.5rem at ≥768, 2rem at <768. Inside a section: head → content 1rem; card gap 1.25rem (`.board-stack`).
- Rules: the 3px double rule appears at exactly three places per page — under the header, above the footer, under every `<thead>`. Section heads use the 1px `rule-strong`. Panels use the 1px `--rule` hairline. Nothing else draws a line.
- The red `margin-rule` on the left at ≥1100px: keep on `/` only, as the one page that is "the ledger".

### Line-length limits

Prose 68ch. Standfirst 68ch. Verdict line 2 ≤ 24ch per line at 390 (two lines max). Card lines never wrap at 390: team nicknames via `shortName()` ("Rangers at Mariners"), players initialled ("N. Reid"), league codes in tables. A Kalshi market title (the one long-text row type on the site, `tab-experiments-phone-p3.png`) truncates to two lines with an ellipsis inside its folded settled list.

### Motion budget

- **Nothing animates above the fold on any route.** No `Reveal` on the header, eyebrow, verdict, board head or first card.
- `StampIn` is kept for exactly one element per page: the funding seal at `/#gate`. The PLAY stamps on cards do not animate (the `/nfl` law: nothing here moves).
- `Reveal` may fire on section heads below the fold, ≤160ms, once, respecting `prefers-reduced-motion` (already guarded).
- `Tally` is cut. `sheet-rise` dies with the tabs. `tape-scroll` dies with the tape. `dot-pulse` dies with the dot.
- The equity curves do not animate. The rail fills do not animate.
- Hover: color and underline only; the `w-10 → w-16` growing rule on "Open autopsy" is allowed (below the fold, 300ms, CSS).

### Tables at 390 — the rule and the exceptions

The `/nfl` law, site-wide: **content never scrolls sideways.** Every `<table>` collapses to stacked rows below 1024px using the `.pass-table` pattern (`display:block` rows, `grid-template-areas`, `<th>` kept in the DOM and visually hidden, `.cell-label` inline labels). Which columns survive in the stacked row:

| Table | Survives at 390 | Drops to the ≥1024 table |
|---|---|---|
| The market (`/desk`) | league, matchup, time (+date if not today), ML pair, spread, disagreement pp + glyph | model %, market %, totals |
| The account by-league (`/`) | league, record, units | staked, ROI (derivable; agate) |
| Gate criteria (`/`) | verdict, criterion, current | none — all three fit |
| Settled (`/`, books) | selection, price, WIN/LOSS stamp-row, ±units | CLV pp (moves into the row's second line when present) |
| Book settled lists (`/experiments`) | selection, result, P&L | entry/fill detail (second line) |
| Prosecution log (`/desk`) | run, raw, killed, rate | — |

Affordance: none needed, because nothing scrolls. If the crit finds a table that genuinely cannot collapse (none is expected), it scrolls inside its own `overflow-x:auto` container with the `/nfl` nav-rail affordance — the static 28px right-edge fade — **and** an agate `scroll →` label above it; a fade alone is not an affordance a reader can name.

---

## 9. Accessibility notes the builder must meet

- **Contrast pairs to use, from the tokens** (text on `--paper` #f2ede3 unless noted): `--ink` #1f1b16; `--ink-2` #5c5547; `--ink-3` #6b6154 (the token comment records it was darkened 2026-08-13 to clear 4.5:1 on all three papers — the builder verifies the three `--ink-3` pairs, on `--paper`, `--paper-2` and `--paper-3`, with a checker and reports the ratios; do not assert them from the comment); `--blue` #2c4e9e; `--win` #1d6a45; `--loss` #b42d1c; `--hold` #75560f (darkened for 4.5:1 on `--paper-3` per its comment — same verification). Never place `--ink-3` text on `--paper-3` without the measured ratio. The `.rail-fill.is-market` bar is `--ink-2` at 45% opacity — a graphical object that must clear 3:1 against `--paper-2` because it is the comparator the whole signature depends on; if it does not, raise opacity to 0.6 or use `--paper-3` solid (measure, then pick).
- **Color never carries meaning alone.** WIN/LOSS/BEAT/MISSED are words in stamps; the diverge glyph is always beside its signed pp figure; the funding state is a word; the run-freshness dot is gone in favor of words.
- **Focus.** The global `:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px }` stays; no `outline: none` anywhere. Header links, card links, `<summary>`s, chips and the chat controls all show it. Keyboard order follows visual order; the sticky header does not trap focus.
- **Links.** Every in-content link is underlined (`.prose a` style: 1px, offset 0.2em, `--blue`). The header nav is the one exception (a `<nav aria-label="Site">` landmark; active = `aria-current="page"` + 2px ink underline). A card that is a link is one `<a>` with an accessible name; nothing interactive nests inside it — the `Open autopsy` control sits in THE PLAY section, not inside a card.
- **Tables.** Every `<table>` has `<caption>` (may be visually hidden) and `<thead><th scope="col">`; the stacked-row collapse keeps the `<th>` elements in the DOM.
- **Folds.** `<details>/<summary>` only; the summary text names the count ("15 settled · unfold"); no hover-only reveals anywhere.
- **Headings.** One `<h1>` per route (on `/` it is the verdict), `<h2>` for every section title, `<h3>` for card names; no skipped levels. Landmarks: one `<header>`, one `<nav>`, one `<main>`, one `<footer>`.
- **Touch targets.** Header links and chips ≥ 44×36px hit areas via padding; card links are their full box.
- **Motion.** All keyframes and GSAP entrances respect `prefers-reduced-motion` (the CSS guards exist; verify `Reveal`/`StampIn` too).
- **Chat.** Keep the existing `role="dialog"`/`aria-modal` for the open state, `role="log"`/`aria-live="polite"` for the transcript, and the focus trap; the inline closed state is a plain `<section>` with a labelled form.
- **Type floor.** No text below 11px (0.6875rem) anywhere at 390 — the crit queries computed sizes.

---

## 10. Crit criteria — ten falsifiable checks

Each is judged from a screenshot or a DOM measurement at 390px or 1440px on the worktree dev server (port 3100).

1. **The fold on `/` at 390.** In the scroll-0 screenshot, the verdict (record, ROI, "locked") is fully visible with its bottom edge ≤ 420px from the top, and the first play card's team stack, PLAY stamp and disagreement figure are all visible within the 844px viewport. With no play open, the two-line empty state is visible instead.
2. **Height.** `document.scrollHeight` on `/` at 390 ≤ 2,800px with today's data (2 NFL plays, 0 agent picks); ≤ 2,400px at 1440. `/experiments` ≤ 3,000px and `/desk` ≤ 4,500px at 390.
3. **One header.** On `/`, `/nfl`, `/experiments`, `/desk` the sticky `<header>` contains the wordmark, exactly four `<a>` links (`/`, `/nfl`, `/experiments`, `/desk`) and the funding token; the current route's link has `aria-current="page"`; the header's bounding height is ≤ 68px at 390 and ≤ 44px at 1440; no other element on the page has `position: sticky` or `fixed` at 390. Legacy check: loading `/#experiments` ends on `/experiments`; `/picks` ends on `/`.
4. **No sideways.** `scrollWidth === clientWidth` on every route at 390; no `<table>` has `scrollWidth > clientWidth`; every `<table>` at 390 renders as stacked rows (no `<tr>` wider than 350px).
5. **The type floor and the furniture.** At 390 no text node has a computed `font-size` < 11px; the DOM contains zero `.folio` elements and none of the strings `FOL.`, `T1`…`T5` (as nav labels), `No. 0`, `Vol. 2026`.
6. **Say it once.** Per route, each of `FUNDING`, `−0.34u`, `67–52`, `−7.1%` appears at most once in the rendered text of `/`; `−7.0%` appears nowhere on the site; the funding seal (`.stamp-true` containing FUNDING) appears exactly once on `/` and zero times on the other routes.
7. **Red ink audit.** Scripted over computed styles: every element whose `color` resolves to `--loss` contains a negative money/units/pp figure, or one of the words LOST / LOSS / KILLED / MISSED / PASS-inside-chat, or is the wordmark asterisk or a `.rules-panel` head. Violators = 0. `--win` text appears on `/nfl` above `#research` zero times.
8. **The way out.** On `/` at 390 there are ≥ 12 `<a>` elements; every NFL play card is an `<a>` whose `href` is `/nfl#play-{legId}` and that id exists on `/nfl`; `THE RECEIPTS →` is present whenever an NFL card is.
9. **The chat covers nothing.** At 390 the `AskTheDesk` closed affordance has `position: static` and its bounding box intersects no other element; at 1440 the fixed tab's bounding box does not intersect the 1120px shell.
10. **`/nfl` parity.** Every `.play-card`, the pass grid, MARKET NOW, THE RULES, THE LEDGER, errata and PART TWO render with the same text as `nfl-phone-p1..8.png` / `nfl-desktop-p1..4.png`; `MastheadStrip` and `ReceiptsNav` do not render; the three disclosure tokens appear once in the page-head eyebrow; no "ROI", "u" units or stake string appears above `#research`.

Sign-off requires all ten green, no kill/must notes open, and a fold screenshot of `/` at 390 I would show either mind without flinching.
