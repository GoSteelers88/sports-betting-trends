import "dotenv/config";
import { prisma as db } from "@/lib/prisma";

async function main() {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const picks = await db.agentPick.findMany({
    where: { createdAt: { gte: since } },
    include: { outcome: true },
    orderBy: { createdAt: "desc" },
  });

  console.log(`\n=== AgentPick rows in last 14d: ${picks.length} ===`);

  const graded = picks.filter((p) => p.outcome && p.outcome.result !== "pending");
  const wins = graded.filter((p) => p.outcome?.result === "win").length;
  const losses = graded.filter((p) => p.outcome?.result === "loss").length;
  const pushes = graded.filter((p) => p.outcome?.result === "push").length;
  const voids = graded.filter((p) => p.outcome?.result === "void").length;
  const pnl = graded.reduce((s, p) => s + (p.outcome?.unitsPnl ?? 0), 0);

  console.log(`Graded: ${graded.length}  W:${wins}  L:${losses}  P:${pushes}  V:${voids}`);
  console.log(`Net units: ${pnl.toFixed(2)}u  ROI: ${graded.length ? ((pnl / graded.length) * 100).toFixed(2) : "0"}% per pick`);

  // Group by day
  const byDay = new Map<string, { w: number; l: number; pnl: number; n: number }>();
  for (const p of graded) {
    const day = p.gameDate.toISOString().slice(0, 10);
    const row = byDay.get(day) ?? { w: 0, l: 0, pnl: 0, n: 0 };
    row.n++;
    if (p.outcome?.result === "win") row.w++;
    if (p.outcome?.result === "loss") row.l++;
    row.pnl += p.outcome?.unitsPnl ?? 0;
    byDay.set(day, row);
  }
  console.log("\n=== By gameDate ===");
  [...byDay.entries()]
    .sort()
    .forEach(([d, r]) => console.log(`${d}  n=${r.n}  ${r.w}-${r.l}  pnl=${r.pnl.toFixed(2)}u`));

  // CLV
  const clvSamples = picks.filter((p) => p.clvCents !== null && p.clvCents !== undefined);
  if (clvSamples.length) {
    const beats = clvSamples.filter((p) => (p.clvCents ?? 0) > 0).length;
    const avgClv = clvSamples.reduce((s, p) => s + (p.clvCents ?? 0), 0) / clvSamples.length;
    console.log(`\n=== CLV ===`);
    console.log(`n=${clvSamples.length}  beat-rate=${((beats / clvSamples.length) * 100).toFixed(1)}%  avgCLV=${avgClv.toFixed(2)}¢`);
  }

  // Edge distribution
  console.log(`\n=== Edge distribution (all 14d picks) ===`);
  const edges = picks.map((p) => p.edge);
  if (edges.length) {
    const sorted = [...edges].sort((a, b) => a - b);
    const mean = edges.reduce((s, e) => s + e, 0) / edges.length;
    console.log(`n=${edges.length}  min=${(sorted[0] * 100).toFixed(1)}%  median=${(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(1)}%  max=${(sorted.at(-1)! * 100).toFixed(1)}%  mean=${(mean * 100).toFixed(1)}%`);
  }

  // By market
  console.log(`\n=== By market ===`);
  const byMarket = new Map<string, { n: number; w: number; l: number; pnl: number }>();
  for (const p of graded) {
    const row = byMarket.get(p.market) ?? { n: 0, w: 0, l: 0, pnl: 0 };
    row.n++;
    if (p.outcome?.result === "win") row.w++;
    if (p.outcome?.result === "loss") row.l++;
    row.pnl += p.outcome?.unitsPnl ?? 0;
    byMarket.set(p.market, row);
  }
  [...byMarket.entries()].forEach(([m, r]) =>
    console.log(`${m.padEnd(10)} n=${r.n}  ${r.w}-${r.l}  pnl=${r.pnl.toFixed(2)}u`)
  );

  // By league
  console.log(`\n=== By league ===`);
  const byLeague = new Map<string, { n: number; w: number; l: number; pnl: number }>();
  for (const p of graded) {
    const row = byLeague.get(p.league) ?? { n: 0, w: 0, l: 0, pnl: 0 };
    row.n++;
    if (p.outcome?.result === "win") row.w++;
    if (p.outcome?.result === "loss") row.l++;
    row.pnl += p.outcome?.unitsPnl ?? 0;
    byLeague.set(p.league, row);
  }
  [...byLeague.entries()].forEach(([l, r]) =>
    console.log(`${l.padEnd(8)} n=${r.n}  ${r.w}-${r.l}  pnl=${r.pnl.toFixed(2)}u`)
  );

  // Recent runs
  const runs = await db.agentRun.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  console.log(`\n=== Last ${runs.length} AgentRuns ===`);
  for (const r of runs) {
    console.log(
      `${r.createdAt.toISOString().slice(0, 16)}  raw=${r.rawAnalystPicks ?? "?"}  killed=${r.criticKilled ?? "?"}  weakened=${r.criticWeakened ?? "?"}  bankrollDropped=${r.bankrollDropped ?? "?"}  final=${r.finalPickCount ?? "?"}  parseFailed=${r.parseFailed}`
    );
  }

  // Losing streak — show last 20 graded
  console.log(`\n=== Last 20 graded picks (newest first) ===`);
  for (const p of graded.slice(0, 20)) {
    console.log(
      `${p.gameDate.toISOString().slice(0, 10)} ${p.league} ${p.market.padEnd(8)} ${p.selection.padEnd(40)} edge=${(p.edge * 100).toFixed(1)}% odds=${p.oddsAmerican > 0 ? "+" : ""}${p.oddsAmerican} -> ${p.outcome?.result} pnl=${p.outcome?.unitsPnl?.toFixed(2)}u  clv=${p.clvCents ?? "n/a"}`
    );
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
