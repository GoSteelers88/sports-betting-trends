# NATESTACKS site redesign — shared context (2026-09-12)

This file is the anchor every agent in the pipeline reads. It is facts and the approved decision, not opinions. Downstream docs: `01-spec.md` (product-manager), `02-art-direction.md` (creative-director), `03-threat.md` (systems-reviewer), then the build.

## The decision

Nate (owner, solo engineer, the site is his) said: *"I really don't like my website. I want it to be more user friendly. right now stuff is all over the place on it."* He approved this direction with "do it all":

**One front door, one header, one page per job, real routes instead of hash tabs. The front page is built for the X audience arriving from a receipts post; the operator views live one click away.**

1. `/` = **today**. The verdict in one line, then every live action across leagues in a single list (agent picks for NBA/MLB/WNBA and the NFL board plays together). When nothing is live, say so once and show what is next.
2. `/nfl` stays **the receipts**. It is the strongest page and the one he shares. Its layout becomes the template for the rest of the site.
3. `/experiments` = the four paper books plus the NFL backtest. `/desk` = quant desk, kill room, market feed (the board), system memory, injury wire. These are operator views.
4. Retire `/picks` (redirect to `/`). Drop the folio numbers and the verdict ticker. Move the chat island so it never covers content.

## Site and audience

- Live: https://sports-betting-trends.vercel.app — "NATESTACKS — The Paper Trial". A Claude-agent quant desk that bets on paper (NBA/MLB/WNBA/NFL) until it clears a funding gate (5 criteria) for real money on Kalshi. Brand posture: brutal honesty, receipts, measurement discipline. Today: −7.1% ROI over 119 graded, funding LOCKED, 2/5 criteria clear, 67-52 record, −0.34u.
- The audience arrives from X (@NateStacksData): Nate posts NFL receipts; the OG card `/api/og/picks` is the front door. There are ZERO visitor analytics (Vercel Web Analytics was disabled at the project level; it is being enabled today, so nothing about traffic is known).
- The X visitor wants: the honest record, what is live right now, and the receipts. Nate as operator wants: is the agent running, what did it pick, gate status, the experiments.

## Measured diagnosis (live site, headless Chrome CDP, 1440px and 390px, 2026-09-12)

Screenshots: `C:\Users\Nate\AppData\Local\Temp\claude\C--Users-Nate\791cd0cb-e648-48f3-bd56-63ea2db4d821\scratchpad\shots\` — files `home-desktop-p1..3.png`, `home-phone-p1..6.png`, `tab-{desk,props,experiments,operations}-{desktop,phone}-pN.png`, `nfl-{desktop,phone}-pN.png`, `picks-{desktop,phone}-p1.png`; `metrics.json` holds DOM metrics per page.

- 3 routes, 3 nav systems: `/` = 5-tab hash rail (`TabShell`, T1 Tonight / T2 The Desk / T3 Props / T4 Experiments / T5 Operations); `/nfl` = its own `receipts-nav` with 9 links, 5 of which point back at the homepage tabs; `/picks` ("The screen") has no nav and renders data dated 2026-05-06 (4 months stale, still live).
- 4 panels are mounted on 2 tabs each in `src/app/page.tsx`: `NflWeek` (tonight + operations), `MlbPropPlays` (tonight + props), `ParlayPaperBook` and `NflExp5` (tonight + experiments). The Tonight tab is 7 panels; 4 are copies.
- The homepage has exactly ONE `<a>` element (the `/nfl` link inside `NflWeek`, about 3,500px down). The live NFL plays are not surfaced on the front page.
- Phone heights at 390px: home (Tonight) 10,177 · experiments 11,991 · operations 14,920 (a 65-row odds table with 33 filter buttons) · /nfl 12,838. Desktop home 7,181.
- Section labels read FOL. 02, 03, 04, 11, 09, Exp. 4, Exp. 5 in that order on Tonight. "Experiment 5" names two different things (the homepage backtest card and the /nfl live receipts).
- Phone defects: the floating `AskTheDesk` island covers the At-a-glance GATE row on `/` and the GB@MIN PLAY stamp on `/nfl`; the NFL week table clips its FAIR/SPREAD/TOTAL columns off the right edge (inside an overflow scroller, so no page-level overflow).
- `VerdictTape` marquee repeats one item three times. `CommandHeader` shows "LAST RUN 3D AGO".
- A visitor's first screen: funding locked, −7.1%, "No edge found", 0 picks, last run 3d ago. Nothing to do, nowhere obvious to go.

## Current architecture (facts)

- Next.js 16.1.6 app router, React 19.2.3, Tailwind v4, GSAP entrance motion (`src/app/_components/motion.tsx`: `Reveal`, `StampIn`, `Tally`). Strict TS, ESM, alias `@/*` → `./src/*`.
- Routes: `src/app/page.tsx` (159 lines; composes 20+ panels into `TabShell` panels), `src/app/nfl/page.tsx` (941 lines, self-contained; imports `TABS`/`tabHref` from `@/lib/site-tabs` for its nav), `src/app/picks/page.tsx` (251), `src/app/layout.tsx` (fonts Fraunces display / Archivo text / IBM Plex Mono numbers; site metadata + OG; `<Analytics />`).
- Components in `src/app/_components/` (29 files, 6,925 lines): AskTheDesk 757, PropsDesk 409, ParlayPaperBook 370, KalshiPaperTrail 361, PickAutopsy 360, MarketFeed 353, KillRoom 353, NflExp5 310, Hero 276, OverallLedger 260, QuantDesk 258, SurvivorBrief (exports `TonightsPlay`) 249, StockPaperBook 233, DevigPaperBook 226, MlbPropPlays 217, DeploymentGate 202, SystemMemory 155, NflWeek 149, LastNightLedger 140, VolatilityInputs 139, TabShell 116, KalshiEquityCurve 98, DevigEquityCurve 93, CommandHeader 85, SectionHeader 61, VerdictTape 52. In `src/app/nfl/_components/`: ResearchAppendix 333, MarketNow 141.
- Data: `src/app/_data/dashboard.ts` → `getDashboardData(): Promise<DashboardData>` (~25 Turso round-trips; ISR `export const revalidate = 300` on `/`). SEVERAL PANELS ARE SERVER COMPONENTS THAT READ FILES VIA `node:fs` AT RENDER (QuantDesk, the paper books, MarketFeed, NflWeek). They must be composed inside server components and never imported into a client component (the build breaks: "does not support external modules: node:fs").
- Design tokens in `src/app/globals.css` (1,714 lines): `--paper #f2ede3` (bone ground), `--ink #1f1b16`, `--rule` / `--rule-strong`, `--win #1d6a45`, `--loss #b42d1c` (THE accent, reserved for money lost), `--hold #75560f`, `--blue #2c4e9e` (model / signal). Utility classes: `headline`, `eyebrow`, `num`, `tag`, `folio`, `rule-double`, `margin-rule`, `sheet-rise`, and the `receipts-*` family used by `/nfl`. Numbers are never set in the display face.
- `src/lib/site-tabs.ts` (tested in `src/lib/__tests__/site-tabs.test.ts`) defines the 5 tabs and `parseTabHash` / `tabHref`. Consumers: `TabShell`, `/nfl/page.tsx`.
- Baseline: `npm test` = 74 files / 1,099 tests green. `npx tsc --noEmit` is clean except 5 PRE-EXISTING errors in `pead.test.ts` (leave them alone). `npm run lint` takes about 8 minutes and reports 126 pre-existing problems repo-wide; attribute by path, do not "fix the repo".

## Addendum (measured 2026-09-12 ~18:45 ET, after the three studio passes started)

- **The data behind "tonight" is stale and the site does not say so.** The committed odds snapshot (`data/processed/latest-odds-api-baseball_mlb.json`, `fetchedAt 2026-09-09T00:35Z`) holds the Sept 8–9 MLB slate. ESPN's real slate for today (Sat Sept 12) is 15 different MLB games; the live board's matchups match Sept 8/9 8-for-8 and today 0-for-8. Every scheduled GitHub Actions workflow failed today (20 of the last 20 runs: agent analyze-slate, grade, CLV capture, refresh odds, Kalshi, convergence, backup). Root cause is being investigated separately; the redesign must NOT assume the data is fresh.
- **Consequence for the build:** the "today" list on `/` must be filtered to games whose start time is today in `America/New_York`, and the page must distinguish three states honestly: (a) live actions exist today, (b) nothing qualifies today (say so once, show what's next), (c) the data is stale (snapshot older than ~36h relative to now, or no game in the snapshot falls on today): print the snapshot's `fetchedAt`/refresh time plainly ("Lines last refreshed Tue Sep 9, 8:35 PM ET") instead of presenting an old slate as tonight. The `NflWeek` board already prints its refresh time; the pattern generalises.
- **The desk (chat) today:** "What games are on today?" and "moneylines for tonight's MLB games" both returned the matchup-shaped fallback ("I don't have a clean live read on that game right now") because the snapshot has no game dated today. The NFL question answered correctly from the static board. The desk is a separate workstream; the redesign only moves its UI.

## Hard constraints

- DO NOT touch: `src/lib/nfl-*`, `src/lib/agent/`, `scripts/`, `data/`, `.github/`, `prisma/`, `src/app/api/`. Do not change `src/app/_data/dashboard.ts` beyond adding a field if truly unavoidable, and say so explicitly. The pick pipeline, crons, and the /nfl publish loop are live and out of scope.
- `/nfl` content: pre-registration Amendment 1 forbids ROI or units for LIVE NFL picks on /nfl. Keep NFL units off /nfl. The receipts page's content and its `receipts-*` styles stay; only its header and nav change to the shared site header.
- Keep the site metadata and `/api/og/picks` untouched. Each route gets its own `title`/`description`.
- Keep ISR (`revalidate = 300`) on data-backed routes; no `force-dynamic`.
- Respect the server/client split (the node:fs panels).
- No new npm dependencies unless unavoidable (say so).
- Keep the editorial paper-and-ink visual language (Fraunces / Archivo / Plex Mono, bone paper, red ink only for money lost). This is an information-architecture and usability redesign, not a rebrand.
- Every number on a page traces to the same source as today (no invented stats). A moved panel keeps its data.
- Accessibility: WCAG AA contrast on all text, visible focus, the nav is real links (`<a href>`) reachable by keyboard, tables have headers, nothing hidden behind hover only.
- Phone first: 390px is the primary viewport. No horizontal page overflow; wide tables scroll inside their own container with a visible affordance, or collapse to cards.
- Old X posts link `/#props`, `/#experiments`, `/#operations`, `/#the-desk`, `/#tonight`, and `/#nfl-week`. These must land somewhere sane after the redesign.
- NO EXTERNAL SIDE EFFECTS: do not push, deploy, open PRs, call Vercel, post anywhere, or touch the master checkout at `C:\Users\Nate\source\repos\GoSteelers88\sports-betting-trends`. Work ONLY in the worktree `C:\Users\Nate\source\repos\GoSteelers88\sports-betting-trends-redesign` (branch `site-redesign`). Do not commit; the orchestrator commits. Never start `next dev` against the master checkout. If you need a dev server, run it from the worktree on port 3100 and stop it when you are done.
