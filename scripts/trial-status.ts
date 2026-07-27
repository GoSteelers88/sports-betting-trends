import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const PAPER_TRIAL_START = new Date("2026-05-06T00:00:00Z");

const CRITERIA = {
  minSampleSize: 200,
  minClvBeatRate: 0.55,
  // UNITS CORRECTION, not a rule change. The gate was pre-registered as
  // "avg CLV ≥ +2¢" against a clvCents column that stored a raw subtraction of
  // American odds — invalid across the ±100 boundary, where +100 and −100 are
  // both 50% implied yet subtract to 200. Three sign-crossing picks ended up
  // carrying 98% of the trial's entire CLV total and flipped this gate from
  // FAIL to PASS on an artifact (it read +13.86¢ while the median was 0.0¢).
  //
  // +2¢ converts to ≈0.46pp at the typical −110 price (−110→−108 = 0.458pp;
  // the range across realistic prices is 0.32–0.50pp). We use 0.45pp — the
  // faithful conversion of the original intent. Deliberately NOT rounded up to
  // 0.5, which would quietly make a pre-registered gate harder to pass.
  minAvgClvProbPoints: 0.45,
  minRoi: 0.02,
  minCriticKillRate: 0.25,
};

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function probPoints(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}pp`;
}

function check(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

async function main() {
  const since = { gte: PAPER_TRIAL_START };

  const outcomes = await prisma.agentOutcome.findMany({
    where: { gradedAt: since },
    include: { pick: true },
  });

  const graded = outcomes.filter((o) => o.result !== "pending" && o.result !== "void");
  const sampleSize = graded.length;

  // clvProbPoints, NOT clvCents — see minAvgClvProbPoints above.
  const clvPicks = await prisma.agentPick.findMany({
    where: { createdAt: since, clvProbPoints: { not: null } },
    select: { clvProbPoints: true },
  });
  const clvSamples = clvPicks
    .map((p) => p.clvProbPoints)
    .filter((c): c is number => c !== null);
  const clvN = clvSamples.length;
  const clvBeats = clvSamples.filter((c) => c > 0).length;
  const clvBeatRate = clvN > 0 ? clvBeats / clvN : 0;
  const avgClv = clvN > 0 ? clvSamples.reduce((a, b) => a + b, 0) / clvN : 0;

  const wins = graded.filter((o) => o.result === "win");
  const totalUnits = graded.reduce((a, o) => a + (o.unitsPnl ?? 0), 0);
  const totalRisked = graded.reduce((a, o) => a + (o.pick.kellyStakeUnits ?? 0), 0);
  const roi = totalRisked > 0 ? totalUnits / totalRisked : 0;

  const runs = await prisma.agentRun.findMany({ where: { createdAt: since } });
  const totalRaw = runs.reduce((a, r) => a + r.rawAnalystPicks, 0);
  const totalKilled = runs.reduce((a, r) => a + r.criticKilled, 0);
  const criticKillRate = totalRaw > 0 ? totalKilled / totalRaw : 0;

  const days = Math.floor((Date.now() - PAPER_TRIAL_START.getTime()) / (1000 * 60 * 60 * 24));

  const checks = [
    {
      name: "Sample size ≥ 200",
      value: sampleSize.toString(),
      passed: sampleSize >= CRITERIA.minSampleSize,
    },
    {
      name: "CLV beat rate ≥ 55% (n≥50)",
      value: `${pct(clvBeatRate)} (n=${clvN})`,
      passed: clvN >= 50 && clvBeatRate >= CRITERIA.minClvBeatRate,
    },
    {
      name: "Avg CLV ≥ +0.45pp (n≥50)",
      value: `${probPoints(avgClv)} (n=${clvN})`,
      passed: clvN >= 50 && avgClv >= CRITERIA.minAvgClvProbPoints,
    },
    {
      name: "ROI ≥ +2%",
      value: pct(roi),
      passed: roi >= CRITERIA.minRoi,
    },
    {
      name: "Critic kill rate ≥ 25%",
      value: `${pct(criticKillRate)} (${totalKilled}/${totalRaw})`,
      passed: criticKillRate >= CRITERIA.minCriticKillRate,
    },
  ];

  const allPassed = checks.every((c) => c.passed);

  console.log(`\nPaper Trial — Day ${days} since ${PAPER_TRIAL_START.toISOString().slice(0, 10)}\n`);
  console.log(`Record: ${wins.length}W-${graded.length - wins.length}L  Units: ${totalUnits >= 0 ? "+" : ""}${totalUnits.toFixed(2)}u  ROI: ${pct(roi)}\n`);

  const nameWidth = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`  [${check(c.passed)}]  ${c.name.padEnd(nameWidth)}  ${c.value}`);
  }
  console.log(`\nOverall: ${allPassed ? "READY TO FUND KALSHI" : "TRIAL ONGOING"}\n`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
