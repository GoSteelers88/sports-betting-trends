# Sports Betting Trends

## What This Is
Full-stack sports betting platform with a Claude-powered agent layer. Tracks
performance, generates picks, runs a 30-day paper trial, and (eventually)
places bets on Kalshi. Scope: **NBA + MLB only**.

## Stack
- **Frontend**: Next.js 16.1.6 + React 19.2.3 + Tailwind v4 + GSAP entrance animations
- **Backend**: Next.js API Routes
- **DB**: Prisma 6.19.3 + Turso (libSQL) — shared across Bot/Actions/Vercel
- **Agent layer**: Anthropic SDK (Sonnet 4.6 analyst+critic, Opus 4.7 dream)
- **Discord bot**: discord.js on Railway (workspace `Nate B's Projects`)
- **Schedulers**: GitHub Actions (run + grade + dream + backup), Vercel Cron (refresh)
- **Scrapers**: Playwright (Node) + scrapling+patchright (Python legacy)
- **Tests**: Vitest (`npm test`)
- **Path alias**: `@/*` → `./src/*`

## How to Run Locally
```bash
npm install
npx playwright install chromium      # for prop scrapers
npm run prisma:generate
npm run dev                          # http://localhost:3000
```

### Required env (.env / .env.local)
```
TURSO_DATABASE_URL=libsql://sports-betting-bot-gosteelers88.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=…
ANTHROPIC_API_KEY=sk-ant-api03-…
THE_ODDS_API_KEY=…
DISCORD_WEBHOOK_URL=…                # one-way notifications
DISCORD_BOT_TOKEN=…                  # for bot
DISCORD_GUILD_ID=…
DISCORD_PICKS_CHANNEL_ID=…
DISCORD_APPLICATION_ID=…
ASSISTANT_SECRET=…                   # /api/assistant/query
CRON_SECRET=…                        # /api/cron/*
DATABASE_URL=file:./prisma/dev.db    # local fallback only
```

### Optional env
```
DISCORD_ERROR_WEBHOOK_URL=…          # alerts channel (falls back to main webhook)
AGENT_OPERATOR_IDS=…,…               # comma-separated user IDs for /agent run, /grade, /dream
GH_PAT=ghp_…                          # for bot to dispatch GH workflows
KALSHI_API_KEY_ID=…                  # placement layer (deferred)
KALSHI_PRIVATE_KEY_PATH=.kalshi-key.pem
```

## Agent Layer (`src/lib/agent/`)

End-to-end pipeline:
```
ingest:odds + ingest:free + ingest:injuries + scrape:nba-props + scrape:mlb-props + scrape:mlb-signals
                                              ↓
                                        picks-logger (snapshots → Turso)
                                              ↓
                                       orchestrator (Sonnet)
                                              ↓
                          ┌────────────┬─────────────┬──────────────┐
                     check_data_health  run_ingest  delegate_to_analyst
                                              ↓
                                         analyst (Sonnet)
                                              ↓ raw picks
                                       grader (pure code, 3% edge minimum)
                                              ↓
                                       critic (Sonnet, fail-closed)
                                              ↓ kept/weakened/killed
                                  bankroll guard (5u cap, edge/stake trim)
                                              ↓ final picks
                          persistFinalPicks ($transaction, idempotent via @@unique)
                                              ↓
                          AgentRun row + AgentPick rows + Discord post
```

Files:
| File | Role |
|---|---|
| `client.ts` | Anthropic client + MODELS map |
| `tools/index.ts` | get_odds (consensus + bestPrice off-market), get_model_probabilities, get_injuries, get_player_props, get_trend_summary, get_mlb_signals |
| `analyst.ts` | Main analyst LLM loop; restricted to moneyline; requires gameTime per pick |
| `grader.ts` | Local pick rubric (edge ≥3%, stake ≤2u, thesis ≥80 chars, NaN-safe) |
| `critic.ts` | Devil's advocate Sonnet pass; parseFailed → fail-closed |
| `bankroll.ts` | 5u/day cap with worst edge/stake-ratio trim; same-game dedup; road-dog cluster flag |
| `health.ts` | Data freshness + sanity checks |
| `runners.ts` | Allowlisted `npm run ingest:*` via spawnSync; 90-min cooldown |
| `autograder.ts` | Auto-grade AgentPick from ESPN finals; ±1d window; upsert(pickId) |
| `dream.ts` | Weekly memory consolidation (Opus); reads pipelineRecord + marketModelComparison |
| `memory.ts` | AgentMemory + recent record formatter for analyst self-awareness |
| `notify.ts` | Discord webhook posts; notifyError() to alerts channel |
| `orchestrator.ts` | The conductor; hard-stops after delegate_to_analyst |

Plus standalone:
- `src/lib/clv-tracker.ts` — captures closing line value (closingOdds vs pickedOdds)
- `src/lib/snapshot-grader.ts` — grades ModelPickSnapshot (NBA/MLB props + market ML/spread/total)
- `src/lib/picks-logger.ts` — logs market best-bets + scraped props to ModelPickSnapshot
- `src/lib/assertCronAuth.ts` + `src/lib/assertServiceAuth.ts` — timing-safe bearer auth

## Database (Prisma + Turso)

**Agent layer models** (added this build):
- `AgentPick` — generated picks; `@@unique([league, gameDate, market, selection])` for cross-run idempotency; clvCents, closingOddsAmerican fields
- `AgentOutcome` — graded results (1:1 with AgentPick); win/loss/push/void; unitsPnl
- `AgentRun` — per-run metadata: rawAnalystPicks, criticKilled, criticWeakened, bankrollDropped, finalPickCount, parseFailed, persistOk
- `AgentMemory` — dream-curated rules (type/scope/rule/reasoning/weight)
- `AgentDreamRun` — weekly dream invocations
- `ModelPickSnapshot` — daily snapshots of market best-bets + NBA props + MLB props; `@@unique([source, snapshotDate, market, selection, player])`

**Legacy (still present)**: Bet, BankrollEntry, StrategyNote, FreeStat

## Schedulers

**GitHub Actions** (`.github/workflows/`):
- `agent-run.yml` — twice daily 14:00 + 22:30 UTC. Refreshes data → orchestrator → commit data back to repo (allowlisted files + secret-grep guard)
- `agent-grade.yml` — daily 13:00 UTC. Grades yesterday's AgentPicks + ModelPickSnapshots; CLV tracker
- `agent-dream.yml` — Mondays 06:00 UTC. Memory consolidation
- `agent-backup.yml` — daily 04:00 UTC. Dumps Turso to `data/backups/turso-YYYY-MM-DD.json`, commits

**Vercel Cron**:
- `/api/cron/refresh` — daily 12:00 UTC. Triggers deploy hook (legacy)

## Discord Bot (Railway)

Project: `sports-betting-bot` in workspace `Nate B's Projects`
Bot identity: `Nate Stacks Data#5062`

**Slash commands** (gated by `requireOperator` = AGENT_OPERATOR_IDS or guild admin):
- `/picks [today|recent] [league]` — show recent picks with edge/stake/CLV
- `/agent run <league>` — dispatch agent-run.yml workflow
- `/agent dream` — dispatch agent-dream.yml workflow
- `/grade <pickId> <result> [notes]` — manual outcome entry
- `/bankroll [days]` — W/L, P&L, ROI, by league
- `/dream` — alias for /agent dream

**Reactions** (only on bot's own messages, only in DISCORD_PICKS_CHANNEL_ID):
- ✅ → `placed by <user>` note
- ❌ → `skipped by <user>` note
- 💯 → confidence-up flag

**Message handler**:
- Parlay handler (in DISCORD_PICKS_CHANNEL_ID only): detects "parlay" keyword or 2+ ML-formatted legs, sends to Claude, replies with leg-by-leg verdict (strong/marginal/kill)

## Dashboard (`src/app/page.tsx`)

Server-component homepage. Sections (in order):
1. **Hero** — date, pulsing live status, slate counts, 4-stat P&L strip (today P&L, last 7d record/units/ROI)
2. **PaperTrial** — Day X/30 progress bar, W/L, 5 funding criteria status, READY badge
3. **PipelineStatus** — 14d totals: raw picks, grader-kept, critic killed, bankroll dropped, kill rate %, avg CLV ¢
4. **MarketPicks** — heuristic best-bets from latest-summary.json
5. **HotPicks** (Bot Picks) — Claude agent picks with edge meter + CLV badge
6. **PlayerProps** — NBA + MLB props, hides when empty
7. **Slate** — every game tonight, grouped by league, with pick badge
8. **Injuries** — collapsed by default
9. **Footer** — generation time + disclaimer

Aesthetic: dark navy gradient, layered radial accents (violet/cyan/pink), glassmorphism, Space Grotesk display + Geist Mono numerals, GSAP staggered fade-up.

## API Routes

**Public** (read-only):
- `GET /api/free-stats/summary` — legacy heuristic summary
- `GET /api/player-props` — legacy NBA prop rankings
- `GET /api/picks/today` — server-rendered picks page
- `GET /api/health`, `/api/moneyline`, `/api/props/today`, `/api/debug-odds`

**Authenticated** (`Authorization: Bearer ${ASSISTANT_SECRET}`):
- `POST /api/assistant/query` — legacy AI assistant
- `POST /api/agent/run` — orchestrator entry (uses spawnSync, only works locally; real schedule in agent-run.yml)
- `POST /api/agent/analyze` — direct analyst (debug)
- `POST /api/agent/grade` — manual outcome entry

**Cron** (`Authorization: Bearer ${CRON_SECRET}` via `assertCronAuth`):
- `POST /api/cron/refresh` — Vercel deploy hook trigger
- `POST /api/cron/grade` — auto-grader
- `POST /api/cron/dream` — dream
- `POST /api/cron/ingest` — ingest dispatcher

All cron routes use timing-safe bearer compare with 4KB header guard.

## Scripts (npm run …)

**Agent layer:**
- `agent:smoke [league|BOTH]` — analyst only, no orchestrator
- `agent:run [league|BOTH]` — full orchestrator pipeline
- `agent:grade [daysBack=1]` — auto-grade AgentPicks
- `agent:dream` — manual dream run

**Picks tracking:**
- `picks:log` — log market + props snapshots to Turso
- `picks:grade` — grade ModelPickSnapshot rows
- `picks:clv` — capture closing line value

**Scrapers:**
- `scrape:nba-props` — RotoWire NBA props (11 markets)
- `scrape:mlb-props` — RotoWire MLB props (4 markets: bases, runs, strikeouts, ER)
- `scrape:mlb-signals` — FanGraphs xwOBA + velocity, RotoWire closer changes

**Bot:**
- `bot:start` — start Discord bot (used by Railway)
- `bot:register` — register slash commands

**Database:**
- `db:backup` — dump Turso to JSON (daily via Actions)
- `prisma:generate`, `prisma:migrate`

**Tests:**
- `test` — Vitest run (14 tests covering bankroll + grader)
- `test:watch` — Vitest watch mode

**Legacy:**
- `ingest:*` — same as before (NBA efficiency, MLB pitchers, free-stats, etc.)
- `scrape:ats|consensus|pitcher-stats` — Python scrapers
- `qa:data` — full ingest + lint + build

## Paper Trial Status

Started **2026-05-06**, runs 30 days (ends ~2026-06-05).

Funding criteria (all 5 must pass before Kalshi placement enabled):
1. Sample size ≥ 30 graded picks
2. ROI ≥ +3%
3. Win rate > 50% (on ≥10 decided picks)
4. Max losing streak < 8
5. Critic kill rate ≥ 25% (raw picks the critic dropped)

Live status visible at `sports-betting-trends.vercel.app` in PaperTrial widget.

## What's NOT Yet Built

- Kalshi placement layer (10 safety gates designed; deferred until paper trial passes)
- Live in-game betting
- Same-game-parlay legs as picks (deferred until placement wired)
- Discord bot two-way real-time orchestrator triggers (current is dispatch-via-GH-API)

## Code Conventions
- Strict TypeScript, ESM
- `ingest-` prefix for ingestion scripts; `latest-*` prefix for snapshots
- API routes: `NextRequest`/`NextResponse`, `dynamic = "force-dynamic"`
- Token-aware team matching (≥4 char tokens) — used in autograder, snapshot-grader, dashboard, bankroll
- Idempotency via `@@unique` constraints; P2002 caught and counted as `skipped`
- Fail-closed defaults (critic JSON parse failure → drop all picks)
- Constant-time auth (`crypto.timingSafeEqual` + length check)
- Allowlisted file commit + secret-grep regex on workflow auto-pushes

## Current Work / Active Context
<!-- Update this section when starting/ending work sessions -->
See `NEXT_SESSION.md` for the prioritized backlog.
