import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

type Row = {
  gameDate: Date;
  team: string;
  opponent: string;
  points: number;
  opponentPoints: number | null;
  atsResult: string | null;
  won: boolean | null;
  homeAway: string | null;
};

function form(history: Row[]) {
  if (!history.length) return { momentum: 0, ats: 0.5, upset: 50 };
  const last10 = history.slice(0, 10);
  const wins = last10.filter((r) => r.won === true).length;
  const losses = last10.filter((r) => r.won === false).length;
  const momentum = last10.length ? (wins - losses) / last10.length : 0;

  const atsGames = last10.filter((r) => r.atsResult === 'W' || r.atsResult === 'L');
  const atsWins = atsGames.filter((r) => r.atsResult === 'W').length;
  const ats = atsGames.length ? atsWins / atsGames.length : 0.5;

  const margins = last10
    .filter((r) => r.opponentPoints != null)
    .map((r) => r.points - (r.opponentPoints as number));
  const margin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
  const upset = Math.round(clamp(50 + margin * 7 + (ats - 0.5) * 25, 1, 99));

  return { momentum, ats, upset };
}

function edgeV1(a: ReturnType<typeof form>, b: ReturnType<typeof form>) {
  return a.momentum * 22 + (a.ats - 0.5) * 26 + (a.upset - b.upset) * 0.3;
}

function edgeV2(a: ReturnType<typeof form>, b: ReturnType<typeof form>) {
  const momentumDiff = a.momentum - b.momentum;
  const atsDiff = a.ats - b.ats;
  const upsetDiff = a.upset - b.upset;
  let e = 0;
  e += clamp(momentumDiff * 18, -12, 12);
  e += clamp(atsDiff * 18, -9, 9);
  e += clamp(upsetDiff * 0.22, -8, 8);
  return clamp(e, -35, 35);
}

function summarize(preds: any[], now: Date, days: number) {
  const cutoff = new Date(now.getTime() - days * 86400000);
  const s = preds.filter((p) => p.date >= cutoff);
  const calc = (suffix: '1' | '2') => {
    const arr = s.map((x) => ({ res: x[`res${suffix}`], e: x[`e${suffix}`] }));
    const dec = arr.filter((x) => x.res === 'W' || x.res === 'L');
    const wins = dec.filter((x) => x.res === 'W').length;
    const losses = dec.filter((x) => x.res === 'L').length;
    const pushes = arr.filter((x) => x.res === 'P').length;
    const wr = dec.length ? wins / dec.length : 0;
    const avgEdge = arr.length ? arr.reduce((a, b) => a + b.e, 0) / arr.length : 0;
    return { bets: arr.length, wins, losses, pushes, wr: Number((wr * 100).toFixed(2)), avgEdge: Number(avgEdge.toFixed(2)) };
  };

  const disag = s.filter((x) => x.diff).length;
  return {
    days,
    sample: s.length,
    disagreement: s.length ? Number(((disag / s.length) * 100).toFixed(2)) : 0,
    v1: calc('1'),
    v2: calc('2'),
  };
}

async function main() {
  const now = new Date();
  const rows = (await prisma.freeStat.findMany({
    where: {
      league: 'NBA',
      gameDate: { lt: now },
      opponentPoints: { not: null },
    },
    orderBy: { gameDate: 'asc' },
    select: {
      gameDate: true,
      team: true,
      opponent: true,
      points: true,
      opponentPoints: true,
      atsResult: true,
      won: true,
      homeAway: true,
    },
  })) as Row[];

  const valid = rows.filter((r) => r.atsResult === 'W' || r.atsResult === 'L' || r.atsResult === 'P');

  const byGame = new Map<string, Row[]>();
  for (const r of valid) {
    const key = `${r.gameDate.toISOString()}|${[r.team, r.opponent].sort().join('|')}`;
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key)!.push(r);
  }

  const games = [...byGame.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const home = g.find((x) => x.homeAway === 'home') ?? g[0];
      const away = g.find((x) => x.team === home.opponent) ?? g[1];
      return { date: home.gameDate, home, away };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const teamHist = new Map<string, Row[]>();
  const preds: any[] = [];

  for (const game of games) {
    const hHist = (teamHist.get(game.home.team) ?? []).slice().reverse();
    const aHist = (teamHist.get(game.away.team) ?? []).slice().reverse();

    const hf = form(hHist);
    const af = form(aHist);

    const h1 = edgeV1(hf, af);
    const a1 = edgeV1(af, hf);
    const pick1 = h1 >= a1 ? 'home' : 'away';
    const row1 = pick1 === 'home' ? game.home : game.away;

    const h2 = edgeV2(hf, af);
    const a2 = edgeV2(af, hf);
    const pick2 = h2 >= a2 ? 'home' : 'away';
    const row2 = pick2 === 'home' ? game.home : game.away;

    preds.push({
      date: game.date,
      pick1,
      pick2,
      res1: row1.atsResult,
      res2: row2.atsResult,
      e1: Math.max(h1, a1),
      e2: Math.max(h2, a2),
      diff: pick1 !== pick2,
    });

    if (!teamHist.has(game.home.team)) teamHist.set(game.home.team, []);
    if (!teamHist.has(game.away.team)) teamHist.set(game.away.team, []);
    teamHist.get(game.home.team)!.push(game.home);
    teamHist.get(game.away.team)!.push(game.away);
  }

  console.log(`Total NBA games evaluated: ${preds.length}`);
  for (const d of [30, 60, 90]) {
    console.log(JSON.stringify(summarize(preds, now, d), null, 2));
  }
}

main().finally(async () => {
  await prisma.$disconnect();
});
