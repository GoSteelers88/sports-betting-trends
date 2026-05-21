---
description: List active AgentMemory rules ordered by weight (what the dream agent has learned)
allowed-tools: Bash(npx tsx*)
---

Read `AgentMemory` rules where `active = true`, ordered by `weight desc`, and print them as a table.

Use an inline tsx invocation that imports `prisma` from `src/lib/prisma.ts`:

```
npx tsx -e "import { prisma } from './src/lib/prisma'; (async () => { const rows = await prisma.agentMemory.findMany({ where: { active: true }, orderBy: { weight: 'desc' } }); for (const r of rows) { console.log(\`[\${r.scope}] w=\${r.weight.toFixed(2)} \${r.type}: \${r.rule}\`); } await prisma.\$disconnect(); })();"
```

After the listing, briefly interpret which rules are likely hard guardrails (weight ≥ 0.5) vs. soft heuristics, and flag any that look stale or contradictory.
