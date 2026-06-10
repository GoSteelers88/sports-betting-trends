/** Head-to-head: favorite-longshot (FLB) backtest vs the agent's real picks.
 *  Reads flb-priced.json + AgentPick/AgentOutcome. Safe to delete. */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const PRICED = path.resolve(process.cwd(), "data", "processed", "flb-priced.json");
const FAV_MIN = 0.8, FAV_MAX = 0.95;
const fee = (p: number) => 0.07 * p * (1 - p);

function wilson(w: number, n: number, z = 1.96) {
  if (!n) return { lo: 0, hi: 1, p: 0 };
  const ph = w / n, d = 1 + z * z / n, c = ph + z * z / (2 * n);
  const m = z * Math.sqrt((ph * (1 - ph) + z * z / (4 * n)) / n);
  return { lo: (c - m) / d, hi: (c + m) / d, p: ph };
}
// mean per-bet ROI (return / amount staked) + t-stat
function roiStats(returns: number[]) {
  const n = returns.length;
  const mean = returns.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const v = n > 1 ? returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(v / Math.max(1, n));
  return { n, roiPct: mean * 100, se: se * 100, t: se > 0 ? mean / se : 0 };
}

interface P { result: "yes" | "no"; bid: number; ask: number; mid: number; }

async function main() {
  // ── FLB favorites ──
  const all = (JSON.parse(fs.readFileSync(PRICED, "utf-8")) as P[]).filter((m) => m.mid > 0 && m.mid < 1);
  const favs = all.filter((m) => m.mid >= FAV_MIN && m.mid <= FAV_MAX);
  const fw = wilson(favs.filter((m) => m.result === "yes").length, favs.length);
  // per-bet ROI = pnl / cost
  const takerRet = favs.map((m) => ((m.result === "yes" ? 1 : 0) - m.ask - fee(m.ask)) / m.ask);
  const makerRet = favs.map((m) => ((m.result === "yes" ? 1 : 0) - m.bid) / m.bid);
  const taker = roiStats(takerRet), maker = roiStats(makerRet);

  // ── Agent picks ──
  const picks = await prisma.agentPick.findMany({ include: { outcome: true } });
  const graded = picks.filter((p) => p.outcome && ["win", "loss", "push", "void"].includes(p.outcome.result));
  const decisive = graded.filter((p) => p.outcome!.result === "win" || p.outcome!.result === "loss");
  const pw = wilson(decisive.filter((p) => p.outcome!.result === "win").length, decisive.length);
  // per-bet ROI = unitsPnl / stake
  const pickRet = graded.map((p) => {
    const stake = (p as any).kellyStakeUnits ?? (p as any).stakeUnits ?? 1;
    return stake > 0 ? (p.outcome!.unitsPnl ?? 0) / stake : 0;
  });
  const pick = roiStats(pickRet);
  const totalPnl = graded.reduce((s, p) => s + (p.outcome!.unitsPnl ?? 0), 0);
  const totalStake = graded.reduce((s, p) => s + ((p as any).kellyStakeUnits ?? 1), 0);

  const row = (name: string, n: number, win: ReturnType<typeof wilson>, r: ReturnType<typeof roiStats>, sig: boolean) =>
    `${name.padEnd(26)} | ${String(n).padStart(4)} | ${(win.p * 100).toFixed(1).padStart(5)}% [${(win.lo * 100).toFixed(0)}-${(win.hi * 100).toFixed(0)}%] | ${(r.roiPct >= 0 ? "+" : "") + r.roiPct.toFixed(2)}%`.padEnd(8) +
    ` | t=${r.t.toFixed(2).padStart(5)} | ${sig ? "✓ SIGNIFICANT" : "✗ noise"}`;

  console.log(`\n${"=".repeat(86)}`);
  console.log(`HEAD-TO-HEAD — per-bet ROI, win rate, statistical significance`);
  console.log("=".repeat(86));
  console.log("strategy                   |    n | win%  [95% CI]   | ROI    | t-stat | verdict");
  console.log("-".repeat(86));
  console.log(row("Agent picks (sports)", pick.n, pw, pick, Math.abs(pick.t) > 2));
  console.log(row("FLB favorites — TAKER", taker.n, fw, taker, taker.t > 2));
  console.log(row("FLB favorites — MAKER", maker.n, fw, maker, maker.t > 2));
  console.log("-".repeat(86));
  console.log(`Agent picks net: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}u on ${totalStake.toFixed(1)}u staked (${graded.length} graded)`);
  console.log(`FLB favorites: avg mid ${(favs.reduce((s, m) => s + m.mid, 0) / favs.length * 100).toFixed(1)}¢, n=${favs.length}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
