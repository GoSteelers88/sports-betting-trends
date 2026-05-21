---
description: Run the orchestrator pipeline locally for a league (NBA, MLB, or BOTH)
argument-hint: <NBA|MLB|BOTH>
allowed-tools: Bash(npm run agent:run*), Bash(npm run agent:smoke*), Bash(npx tsx*)
---

Run the orchestrator locally for `$ARGUMENTS` (default to BOTH if empty).

1. Confirm the user wants a real orchestrator run (real Anthropic + odds API spend). If they want a dry run instead, suggest `npm run agent:smoke -- $ARGUMENTS`.
2. Run `npm run agent:run -- $ARGUMENTS` and stream output.
3. After the run completes, summarize: rawAnalystPicks → graderKept → criticKilled → bankrollDropped → finalPickCount from the last AgentRun row (use a short tsx one-liner to read `prisma.agentRun.findFirst({ orderBy: { createdAt: 'desc' } })`).
4. If `parseFailed === true` or `persistOk === false`, surface that loudly.
