import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.bet.deleteMany();
  await prisma.bankrollEntry.deleteMany();
  await prisma.strategyNote.deleteMany();

  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  await prisma.bet.createMany({
    data: [
      { gameDate: daysAgo(30), league: "NFL", market: "Spread", selection: "PIT -3.5", oddsAmerican: -110, stakeUnits: 1.5, result: "WIN" },
      { gameDate: daysAgo(27), league: "NBA", market: "Total", selection: "LAL/GSW Over 229.5", oddsAmerican: -105, stakeUnits: 1, result: "LOSS" },
      { gameDate: daysAgo(25), league: "NHL", market: "Moneyline", selection: "Rangers ML", oddsAmerican: 120, stakeUnits: 0.75, result: "WIN" },
      { gameDate: daysAgo(22), league: "NFL", market: "Props", selection: "A. Brown 70+ rec yds", oddsAmerican: -115, stakeUnits: 1, result: "PUSH" },
      { gameDate: daysAgo(19), league: "NBA", market: "Spread", selection: "Celtics -5", oddsAmerican: -110, stakeUnits: 1.25, result: "WIN" },
      { gameDate: daysAgo(17), league: "NFL", market: "Moneyline", selection: "Bills ML", oddsAmerican: -140, stakeUnits: 2, result: "LOSS" },
      { gameDate: daysAgo(15), league: "NHL", market: "Total", selection: "Under 6", oddsAmerican: 100, stakeUnits: 1, result: "WIN" },
      { gameDate: daysAgo(12), league: "NBA", market: "Props", selection: "Doncic 8+ ast", oddsAmerican: -125, stakeUnits: 1, result: "WIN" },
      { gameDate: daysAgo(10), league: "NFL", market: "Spread", selection: "Chiefs -2.5", oddsAmerican: -108, stakeUnits: 1.5, result: "LOSS" },
      { gameDate: daysAgo(8), league: "NBA", market: "Moneyline", selection: "Knicks ML", oddsAmerican: 135, stakeUnits: 0.75, result: "WIN" },
      { gameDate: daysAgo(6), league: "NHL", market: "Props", selection: "Matthews Anytime Goal", oddsAmerican: 145, stakeUnits: 0.5, result: "LOSS" },
      { gameDate: daysAgo(4), league: "NFL", market: "Total", selection: "Over 47", oddsAmerican: -110, stakeUnits: 1.25, result: "WIN" },
      { gameDate: daysAgo(2), league: "NBA", market: "Spread", selection: "Suns +4", oddsAmerican: -110, stakeUnits: 1, result: "WIN" }
    ]
  });

  await prisma.bankrollEntry.createMany({
    data: [
      { date: daysAgo(35), amount: 1000, type: "DEPOSIT", note: "Starting bankroll" },
      { date: daysAgo(20), amount: 250, type: "DEPOSIT", note: "Mid-season top-up" },
      { date: daysAgo(5), amount: -120, type: "WITHDRAWAL", note: "Profit partial withdrawal" }
    ]
  });

  await prisma.strategyNote.createMany({
    data: [
      { title: "NFL divisional unders", body: "Stronger in bad weather; avoid dome games. Keep totals to max 1.25u.", tag: "NFL" },
      { title: "NBA back-to-back fade", body: "Target teams on road B2B with travel > 800 miles.", tag: "NBA" },
      { title: "Prop discipline", body: "Only play props where edge > 4% versus projected fair line.", tag: "Props" }
    ]
  });
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
