# Agent Layer

This directory is the core of the platform. Everything else is a frontend, scheduler, or persistence helper around the pipeline defined here.

## Pipeline at a glance

```
data (data/processed/*.json + Prisma)
  → orchestrator.ts  (Sonnet, 3 tools)
      ├─ check_data_health()      → health.ts
      ├─ run_ingest(scripts)      → runners.ts  (allowlisted, 90-min cooldown)
      └─ delegate_to_analyst()    → HARD-STOP after this call (orchestrator.ts:245)
  → analyst.ts       (Sonnet, 11 tools, ≤8 iterations)
      → raw AnalystPick[]
  → grader.ts        (pure code, no LLM)
      → kept + dropped
  → critic.ts        (Sonnet, fail-closed on parse)
      → keep / kill / weaken decisions
  → critic floor safety net (orchestrator.ts:324-356)
      → rescue top-edge pick at 0.5× stake if critic kills ≥3 on ≥3 raw
  → bankroll.ts      (pure code, 5u/day cap)
      → final picks
  → persistFinalPicks  (analyst.ts:368-376, P2002 → counted as skipped)
  → AgentRun + AgentPick rows in Turso
  → notify.ts → Discord
```

## Models — pull from MODELS map, never hardcode

`client.ts` exports `MODELS`:
- `analyst` / critic → `claude-sonnet-4-6`
- `dream` → `claude-opus-4-7`

If you need a new model alias, add it to the map. Don't sprinkle `"claude-…"` strings through the pipeline.

## Fail-closed invariants

These are load-bearing. Don't relax them without explicit user buy-in.

| Invariant | Where | Behavior |
|---|---|---|
| Critic JSON parse failure | `critic.ts:294-300` | Drop **all** picks for the run. Logged + notified. |
| Orchestrator hard-stop after delegate | `orchestrator.ts:245` | `analystDone = true` ends the orchestrator's LLM loop immediately. |
| Scope guard (NBA + MLB + WNBA) | `analyst.ts:170-172`, `orchestrator.ts:115-121` | `isInScope(league)` throws `OutOfScopeLeagueError` + notify. WNBA re-added 2026-06-30 (trial-integrated); NHL/NCAAB still stripped. |
| Cross-run idempotency | `analyst.ts:368-376` | Prisma P2002 on `@@unique([league, gameDate, market, selection])` caught, counted as skipped, no throw. |
| Critic floor safety net | `orchestrator.ts:324-356` | If critic kills ≥3 grader-kept picks on ≥3 raw, rescue top-edge pick at 0.5× (only if edge ≥6%). |
| Grader edge tolerance band | `grader.ts:72-87` | Edges in `[5.5%, 6%)` → keep at 0.5× stake with warning. Below 5.5% → drop. |

## Tool contracts (`tools/index.ts`)

| Tool | Data source | Notes |
|---|---|---|
| `get_odds(league)` | `data/processed/latest-odds-api-*.json` | Consensus + bestPrice off-market. |
| `get_model_probabilities(league)` | `data/processed/{nba,mlb}-model*.json` | Stale (>6h) status passed back in-band. |
| `get_injuries(league)` | `data/processed/injuries-*.json` | |
| `get_player_props(league)` | `data/processed/latest-player-props*.json` | NBA + MLB; absence ≠ error. |
| `get_trend_summary(league)` | `data/processed/latest-summary.json` | Legacy heuristic best-bets. |
| `get_mlb_signals()` | `data/processed/mlb-advanced-signals.json` | FanGraphs xwOBA/velo + closer changes. |
| `get_prop_projection(...)` | deterministic in-memory | No external I/O. Use for sanity-checking prop edges. |
| `get_dream_memory()` | Prisma `AgentMemory` (active=true) | Injected via `ToolDeps`. |
| `get_team_recent_records()` | Prisma `AgentPick` + `AgentOutcome` (14d) | Injected via `ToolDeps`. |
| `get_quant_desk_analysis(league)` | `data/processed/quant-desk-mlb-book.json` | MLB-only. Deterministic quant desk open plays + CLV record. Corroborating signal — advisory, not a required step. |

All file-backed tools check staleness (`>6h` → returns a `stale` flag the analyst sees in-band). Don't silently drop stale data — let the analyst decide.

## Memory loop

- **Dream writes** (`dream.ts:164-184`):
  - `prisma.agentMemory.create({ type, scope, rule, reasoning, weight, evidence, active: true })`
  - `prisma.agentMemory.updateMany({ where: { id, active: true }, data: { active: false } })` for retirements
- **Analyst reads** (`analyst.ts:183` → `memory.ts:75-89`):
  - `getActiveMemoriesForScope(scope)` → `where: { active: true, scope: { in: [scope, "ALL"] } }`, ordered by `weight desc`
  - Formatted into system prompt under "MEMORY RULES (HARD GUARDRAILS)".
- **Critic reads** (`orchestrator.ts:286` → `critic.ts:99-125`):
  - Same query; embedded in JSON payload to LLM. Rules with `weight >= 0.5` are hard guardrails — thesis must cite + override reason or pick is killed.

## Grader thresholds

- `MIN_EDGE = 0.06` (6%) — raised from 3% in May 2026 to clear vig + safety margin.
- Stake cap: 2u per pick.
- Thesis ≥80 chars.
- NaN-safe on every numeric field; both probabilities clamped to `(0.01, 0.99)`.
- Tolerance band `[5.5%, 6%)` keeps the pick at 0.5× stake (avoids silent rounding drops).

## Bankroll guard

- 5u/day cap.
- ≤1 ML per game; ≤2 props per game; ≤1 prop per player.
- Same-game dedup (per-run only — cross-run handled by `@@unique`).
- Road-dog cluster flag (≥3 road dogs same day).
- On conflict, drops the lowest-edge / worst stake-ratio first.

## When editing this directory

- Run `npm test` before committing (Vitest covers bankroll + grader + autograder-match + x-formatter).
- New tools require **both** an entry in `TOOL_DEFINITIONS` *and* a handler in `buildToolHandlers(deps)`. Forgetting one is a silent fail.
- New fail-closed paths must call `notifyError()` (`notify.ts`) so we hear about it.
- Never hardcode model strings — extend `MODELS` in `client.ts`.
- Schema changes (`AgentPick`, `AgentOutcome`, etc.) require `npm run prisma:migrate` and a backup verification before deploying.
