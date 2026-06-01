# Next Session — Backlog

## 2026-06-01 — MLB model rebuilt, then stood down (evidence-based)

Investigated "MLB is the only league under .500." Root cause was negative CLV
(no real edge), not bad luck. Rebuilt the MLB model with forward-looking
Statcast inputs (xERA/xwOBA) + log5/Pythagorean + market shrinkage, replacing
the LightGBM Python sidecar. Built a leak-free as-of-date CLV backtest harness.

**Verdict: no demonstrated edge.** Two backtests (~688 games) + adversarially-
verified deep research (peer-reviewed *Management Science* Simon 2024; an
independent production bot that reached the same conclusion) confirm full-game
MLB ML is too efficient for public-data fundamentals. F5/totals/props as "more
beatable" were REFUTED. Default shrinkage set to **w=0.3** (model defers to the
line); **MLB stays at floor stakes** (the bankroll guard was right all along).
Work committed to branch `mlb-model-rebuild` (not pushed — merge is a deploy call).

**The big takeaway is system-wide, not just MLB:** overall trial CLV is also
failing (~20% beat, n=10), so the "fundamentals beat the market" premise is the
limiter for NBA too. The research's prescription: build fair value from a
**de-vigged SHARP book** (Pinnacle/Circa) as the primary signal and only bet
when you beat it. **Binding constraint = no free sharp-book feed.**

### Recommended next campaign (replaces chasing more bet-types)
1. **Acquire a sharp reference line** — the highest-value unlock. Options to
   scope: Pinnacle/Circa via odds screens, a free odds-API tier, or Kalshi's
   own book as the anchor. Without this, no amount of modeling beats the wall.
2. **Re-architect pick-gen around de-vigged-sharp fair value** (applies to NBA
   *and* MLB): edge = our_price vs de-vigged_sharp_close; margin of safety ∝
   market efficiency; LLM/model becomes a secondary input, not the price.
3. Only then revisit the one credible edge (line-movement *overreaction*, in
   lopsided/weekend-day games) — needs line-movement capture (`line_movement`
   is currently hardcoded 0) and likely still won't clear vig.

Kalshi placement remains correctly gated (5 criteria not met; CLV failing).

## Where we left off (2026-05-07, ~07:00 UTC)

The full trial-phase build shipped overnight. **System is autonomous.**

- 30-day paper trial running (Day 2 of 30, ends ~2026-06-05)
- Twice-daily orchestrator firing on schedule (14:00 + 22:30 UTC)
- Daily auto-grader at 13:00 UTC (bot picks + market snapshots + props)
- Weekly dream at Mon 06:00 UTC
- Nightly Turso backup at 04:00 UTC
- Bot live on Railway as `Nate Stacks Data#5062`
- Vercel dashboard at `sports-betting-trends.vercel.app`

**Latest commits**:
- `d4871e8` — feat(complete): spread/total grading, CLV display, parlay handler, tests, backup
- `ed03ccd` — feat(edge): CLV tracker, off-market scanner, MLB props, MLB advanced signals
- `c8949e2` — fix(review-pass-4): agents know their record; dashboard reads AgentRun
- `37bc188` — fix(review-pass-3): real gameDate, AgentRun metadata, market labels
- `2bc6a4f` — fix(review-pass-2): paper trial widget, idempotency, persist after critic
- `2f8b835` — fix(review-pass-1): security/correctness/architecture HIGH findings

## Top priority — when ready

### 1. Kalshi placement layer (full autopilot) — ~3-4 hrs
**Only flip on after paper trial passes all 5 criteria.**

Build order:
- `src/lib/kalshi/client.ts` — RSA-signed REST client (KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PATH already in `.env`)
- `src/lib/kalshi/resolver.ts` — AgentPick → Kalshi market_ticker
- `src/lib/kalshi/orders.ts` — order builder (limit only, never market)
- `src/lib/kalshi/gates.ts` — 10 safety gates: kill switch, daily loss circuit breaker, idempotency, position-already-open, bankroll cap, rate limit, streak halt, edge sanity (>25% = halt), coverage anomaly (>5/day = halt), balance drift (>30% in 6h = halt)
- `src/lib/kalshi/settlement.ts` — settlement watcher (cron)
- `src/lib/kalshi/audit.ts` — `KalshiAuditLog` table for every API call
- New Prisma models: `KalshiOrder`, `KalshiAuditLog`, `AgentControlFlag`
- New `/api/kalshi/place` endpoint (admin-gated)
- Discord post: "✅ PLACED · Tigers YES @ $0.41 · Order #abc..."
- Daily summary: "📊 Yesterday on Kalshi: 4 placed, 2-2, +$0.18"

**Test path**: $0.30 funded already. Place 1 underdog contract end-to-end before scaling.

### 2. Discord error channel setup — 5 min
Currently falls back to main webhook. To split: create a `#agent-alerts` channel in Discord, generate webhook, set `DISCORD_ERROR_WEBHOOK_URL` secret on Railway + GitHub Actions + Vercel.

### 3. GH_PAT for slash commands — 5 min
Without it, `/agent run` and `/dream` slash commands return helpful errors. Steps:
- GitHub Settings → Developer Settings → Fine-grained PAT
- Repo: GoSteelers88/sports-betting-trends
- Permissions: Actions Read+Write
- Set as Railway env var: `railway variables --set "GH_PAT=ghp_…"`
- Set as GitHub repo secret too if needed (for orchestrator-triggered ones)

## Mid-priority

### 4. Spread/total picks (after paper trial) — 1 hr
Currently the analyst is restricted to moneyline. Once we trust the system:
- Remove the "ONLY produce moneyline picks" line from analyst prompt
- Spread/total grading is already wired in `snapshot-grader.gradeMarketPicks` (lines 380-440)
- Update analyst rubric grader if needed

### 5. AgentMemory growth — runs automatically
The dream agent runs every Monday and writes to `AgentMemory`. After ~3 weeks of graded picks the analyst's prompt should include 5-15 active rules. Monitor `prisma.agentMemory.findMany({ where: { active: true } })` to see what it learned.

### 6. CLV trend visualization — 30 min
Add a small CLV-over-time line chart to PaperTrial widget once we have ≥10 CLV samples. Recharts already in deps.

## Lower priority — when bored

### 7. NHL / NCAAB support — 2-3 hrs each
Pattern is identical: scraper, model file, autograder labels, analyst tools. Not in current scope per "NBA + MLB only" decision.

### 8. Live in-game betting — high complexity
Real-time WebSocket feed, sub-second decision making, in-game model. Defer indefinitely.

### 9. Convergence engine integration — ~1 hr
`convergence-engine/` package exists but is unused by the agent. Polymarket data could be a tool the analyst calls (`get_polymarket_market`). Real value once placement is on multiple venues.

### 10. More tests
Currently 14 tests covering bankroll + grader. Add:
- snapshot-grader.ts (date proximity matching, prop stat lookups)
- critic.ts (parse-failure handling, undercount detection)
- clv-tracker.ts (consensus calculation, team matching)

## Deferred / out of scope

- DraftKings / FanDuel / BetMGM scrapers — ToS gray area
- Same-game-parlay generation — needs placement layer
- Mobile app — not happening
- Computer Use browser control for placement — Kalshi REST is cleaner

## Open questions to revisit

- **Paper trial start date** — hardcoded `2026-05-06` in `dashboard.ts:419`. After 30 days, do we restart or fold into a rolling 30d?
- **Critic kill-rate criterion** — is 25% the right threshold? May need to relax based on real data.
- **Anthropic model versions** — currently Sonnet 4.6 (analyst+critic) + Opus 4.7 (dream). Consider locking dated aliases.
- **Discord error channel naming** — `#agent-alerts` vs `#bot-errors` vs combined with picks channel.

## Quick reference for next-session prompts

If you want to start fast:
- "Show me the 14:00 UTC run output and how many picks shipped"
- "What's the current paper trial criteria status?"
- "Grade yesterday's picks and tell me the W-L"
- "Wire up the Kalshi placement client" (only when ready)

## Session cost so far

~$2.50 in Anthropic tokens across:
- Multiple orchestrator runs (Sonnet)
- 4 passes of multi-agent code review (12 specialist agents total)
- Dream agent runs

All other features (scrapers, grader, CLV tracker, dashboard redesign, bot, tests, backup) are pure code — $0 marginal token cost.
