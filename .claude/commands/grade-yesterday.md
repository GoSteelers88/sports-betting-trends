---
description: Auto-grade yesterday's AgentPicks and print W/L by league
allowed-tools: Bash(npm run agent:grade*), Bash(npx tsx*)
---

1. Run `npm run agent:grade -- 1` (grades picks from the last 1 day window).
2. Then read AgentOutcome rows with `gradedAt` within the last 24 hours using a small inline tsx invocation against `src/lib/prisma.ts`.
3. Print a table: league · wins · losses · pushes · net units. Include pick-level lines for any losses ≥ 1u so the user can spot patterns.
