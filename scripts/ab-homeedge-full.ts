import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { computeBasketballAdvanced, type BoxScoreRow, type StandingsEntry } from '../src/lib/advanced-metrics';

const root = process.cwd();

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

type Row = {
  gameDate: Date;
  team: string;
  opponent: string;
  points: number;
  opponentPoints: number | null;
  spread: number | null;
  atsResult: string | null;
  won: boolean | null;
  homeAway: string | null;
  fgm: number | null;
  fga: number | null;
  threepm: number | null;
  threepa: number | null;
  ftm: number | null;
  fta: number | null;
  offRebounds: number | null;
  defRebounds: number | null;
  steals: number | null;
  blocks: number | null;
  turnovers: number | null;
};

function regressionSpread(marketSpread: number | null): number | null {
  if (marketSpread == null) return null;
  const abs = Math.abs(marketSpread);
  const sign = marketSpread < 0 ? -1 : 1;
  const regressed = abs <= 7 ? abs * 0.92 : 6.44 + (abs - 7) * 0.45;
  return Math.round(sign * regressed * 10) / 10;
}

function restEdgeBonus(days: number | null): number {
  if (days == null) return 0;
  if (days <= 1) return -4;
  if (days === 2) return -1.5;
  if (days >= 7) return 1.5;
  if (days >= 5) return 0.5;
  return 0;
}

function daysOfRest(sortedHistoryDesc: Row[], upcomingMs: number): number | null {
  const lastGame = sortedHistoryDesc[0];
  if (!lastGame) return null;
  return Math.round((upcomingMs - lastGame.gameDate.getTime()) / 86400000);
}

function toBoxScoreRow(r: Row): BoxScoreRow {
  return {
    team: r.team,
    opponent: r.opponent,
    points: r.points,
    opponentPoints: r.opponentPoints,
    fgm: r.fgm,
    fga: r.fga,
    threepm: r.threepm,
    threepa: r.threepa,
    ftm: r.ftm,
    fta: r.fta,
    offRebounds: r.offRebounds,
    defRebounds: r.defRebounds,
    turnovers: r.turnovers,
    passingYards: null,
    rushingYards: null,
    opponentYards: null,
    turnoversFor: null,
    turnoversAgainst: null,
    thirdDownConv: null,
    thirdDownAtt: null,
    redZoneConv: null,
    redZoneAtt: null,
    timeOfPossession: null,
    hits: null,
    errors: null,
  };
}

function teamForm(rowsDesc: Row[], standings: StandingsEntry[]) {
  if (!rowsDesc.length) return { momentum: 0, atsForm: 0.5, upsetProxy: 50, netRating: null as number | null, sos: null as number | null };

  const last10 = rowsDesc.slice(0, 10);
  const wins = last10.filter((r) => r.won === true).length;
  const losses = last10.filter((r) => r.won === false).length;
  const momentum = last10.length ? Number(((wins - losses) / last10.length).toFixed(3)) : 0;

  const atsGames = last10.filter((r) => r.atsResult === 'W' || r.atsResult === 'L');
  const atsWins = atsGames.filter((r) => r.atsResult === 'W').length;
  const atsForm = atsGames.length ? Number((atsWins / atsGames.length).toFixed(3)) : 0.5;

  const marginVals = last10
    .filter((r) => r.opponentPoints != null)
    .map((r) => r.points - (r.opponentPoints as number));
  const margin = marginVals.length ? marginVals.reduce((a, b) => a + b, 0) / marginVals.length : 0;
  const upsetProxy = Math.round(clamp(50 + margin * 7 + (atsForm - 0.5) * 25, 1, 99));

  const adv = computeBasketballAdvanced(last10.map(toBoxScoreRow), standings);
  return { momentum, atsForm, upsetProxy, netRating: adv.netRating, sos: adv.sos };
}

function edgeV1(a: ReturnType<typeof teamForm>, b: ReturnType<typeof teamForm>) {
  const net = a.netRating != null && b.netRating != null ? (a.netRating - b.netRating) * 0.5 : 0;
  const sos = a.sos != null && b.sos != null ? (a.sos - b.sos) * 15 : 0;
  return a.momentum * 22 + (a.atsForm - 0.5) * 26 + (a.upsetProxy - b.upsetProxy) * 0.3 + net + sos;
}

function edgeV2(a: ReturnType<typeof teamForm>, b: ReturnType<typeof teamForm>, restDiff: number) {
  const momentumDiff = a.momentum - b.momentum;
  const atsDiff = a.atsForm - b.atsForm;
  const upsetDiff = a.upsetProxy - b.upsetProxy;
  const netDiff = a.netRating != null && b.netRating != null ? a.netRating - b.netRating : 0;
  const sosDiff = a.sos != null && b.sos != null ? a.sos - b.sos : 0;

  let e = 0;
  e += clamp(momentumDiff * 18, -12, 12);
  e += clamp(atsDiff * 18, -9, 9);
  e += clamp(upsetDiff * 0.22, -8, 8);
  e += clamp(netDiff * 0.75, -12, 12);
  e += clamp(sosDiff * 10, -6, 6);
  e += clamp(restDiff * 1.5, -5, 5);
  return clamp(e, -35, 35);
}

type Weights = {
  momentumW: number;
  atsW: number;
  upsetW: number;
  netW: number;
  sosW: number;
  restW: number;
};

function edgeParam(a: ReturnType<typeof teamForm>, b: ReturnType<typeof teamForm>, restDiff: number, w: Weights) {
  const momentumDiff = a.momentum - b.momentum;
  const atsDiff = a.atsForm - b.atsForm;
  const upsetDiff = a.upsetProxy - b.upsetProxy;
  const netDiff = a.netRating != null && b.netRating != null ? a.netRating - b.netRating : 0;
  const sosDiff = a.sos != null && b.sos != null ? a.sos - b.sos : 0;

  let e = 0;
  e += clamp(momentumDiff * w.momentumW, -12, 12);
  e += clamp(atsDiff * w.atsW, -9, 9);
  e += clamp(upsetDiff * w.upsetW, -8, 8);
  e += clamp(netDiff * w.netW, -12, 12);
  e += clamp(sosDiff * w.sosW, -6, 6);
  e += clamp(restDiff * w.restW, -5, 5);
  return clamp(e, -35, 35);
}

function scoreFromEdge(modelEdge: number, spread: number | null, homeAdj: number, restAdj: number) {
  const largeFavPenalty = spread != null && spread < -10 ? (Math.abs(spread) - 10) * 1.0 : 0;
  const rawScore = 52 + modelEdge * 0.32;
  const score = Math.round(clamp(rawScore + homeAdj + restAdj - largeFavPenalty, 1, 99));
  const confidence = Number((clamp(0.45 + Math.abs(score - 50) / 95, 0.35, 0.9) * 100).toFixed(0));
  return { score, confidence };
}

function summarize(preds: any[], now: Date, days: number) {
  const cutoff = new Date(now.getTime() - days * 86400000);
  const s = preds.filter((p) => p.date >= cutoff);
  const calc = (k: 'v1' | 'v2') => {
    const arr = s.map((x) => ({ res: x[k].res, edge: x[k].edge, score: x[k].score }));
    const dec = arr.filter((x) => x.res === 'W' || x.res === 'L');
    const wins = dec.filter((x) => x.res === 'W').length;
    const losses = dec.filter((x) => x.res === 'L').length;
    const pushes = arr.filter((x) => x.res === 'P').length;
    const wr = dec.length ? (wins / dec.length) * 100 : 0;
    const avgEdge = arr.length ? arr.reduce((a, b) => a + b.edge, 0) / arr.length : 0;
    const avgScore = arr.length ? arr.reduce((a, b) => a + b.score, 0) / arr.length : 0;
    return { bets: arr.length, wins, losses, pushes, wr: Number(wr.toFixed(2)), avgEdge: Number(avgEdge.toFixed(2)), avgScore: Number(avgScore.toFixed(2)) };
  };

  const disagreements = s.filter((x) => x.v1.pick !== x.v2.pick).length;
  return { days, sample: s.length, disagreementPct: s.length ? Number(((disagreements / s.length) * 100).toFixed(2)) : 0, v1: calc('v1'), v2: calc('v2') };
}

async function main() {
  const standingsPath = path.join(root, 'data', 'processed', 'standings-nba.json');
  const standings: StandingsEntry[] = fs.existsSync(standingsPath)
    ? (JSON.parse(fs.readFileSync(standingsPath, 'utf8')) as StandingsEntry[])
    : [];

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
      spread: true,
      atsResult: true,
      won: true,
      homeAway: true,
      fgm: true,
      fga: true,
      threepm: true,
      threepa: true,
      ftm: true,
      fta: true,
      offRebounds: true,
      defRebounds: true,
      steals: true,
      blocks: true,
      turnovers: true,
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

  const hist = new Map<string, Row[]>();
  const preds: any[] = [];

  for (const game of games) {
    const hHistDesc = [...(hist.get(game.home.team) ?? [])].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());
    const aHistDesc = [...(hist.get(game.away.team) ?? [])].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());

    const hf = teamForm(hHistDesc, standings);
    const af = teamForm(aHistDesc, standings);

    const hRest = daysOfRest(hHistDesc, game.date.getTime());
    const aRest = daysOfRest(aHistDesc, game.date.getTime());
    const restDiffHome = restEdgeBonus(hRest) - restEdgeBonus(aRest);
    const restDiffAway = -restDiffHome;

    const h1 = edgeV1(hf, af);
    const a1 = edgeV1(af, hf);
    const pickV1Home = h1 >= a1;
    const pickV1 = pickV1Home ? game.home : game.away;
    const modelEdgeV1 = pickV1Home ? h1 : a1;
    const homeAdjV1 = pickV1Home ? 2.5 : -2.5;
    const restAdjV1 = pickV1Home ? restDiffHome : restDiffAway;
    const scoreV1 = scoreFromEdge(modelEdgeV1, pickV1.spread, homeAdjV1, restAdjV1);

    const h2 = edgeV2(hf, af, restDiffHome);
    const a2 = edgeV2(af, hf, restDiffAway);
    const pickV2Home = h2 >= a2;
    const pickV2 = pickV2Home ? game.home : game.away;
    const modelEdgeV2 = pickV2Home ? h2 : a2;
    const homeAdjV2 = pickV2Home ? 2.5 : -2.5;
    const restAdjV2 = pickV2Home ? restDiffHome : restDiffAway;
    const scoreV2 = scoreFromEdge(modelEdgeV2, pickV2.spread, homeAdjV2, restAdjV2);

    preds.push({
      date: game.date,
      v1: { pick: pickV1.team, res: pickV1.atsResult, edge: modelEdgeV1, score: scoreV1.score },
      v2: { pick: pickV2.team, res: pickV2.atsResult, edge: modelEdgeV2, score: scoreV2.score },
    });

    if (!hist.has(game.home.team)) hist.set(game.home.team, []);
    if (!hist.has(game.away.team)) hist.set(game.away.team, []);
    hist.get(game.home.team)!.push(game.home);
    hist.get(game.away.team)!.push(game.away);
  }

  console.log(`Total NBA games evaluated: ${preds.length}`);
  for (const d of [30, 60, 90]) {
    console.log(JSON.stringify(summarize(preds, now, d), null, 2));
  }

  // Small parameter sweep around v2
  const candidates: Weights[] = [];
  for (const momentumW of [14, 18, 22])
    for (const atsW of [12, 18, 24])
      for (const upsetW of [0.16, 0.22, 0.28])
        for (const netW of [0.6, 0.75, 0.9])
          for (const sosW of [8, 10, 12])
            for (const restW of [1.0, 1.5, 2.0])
              candidates.push({ momentumW, atsW, upsetW, netW, sosW, restW });

  const byGame2 = new Map<string, Row[]>();
  for (const r of valid) {
    const key = `${r.gameDate.toISOString()}|${[r.team, r.opponent].sort().join('|')}`;
    if (!byGame2.has(key)) byGame2.set(key, []);
    byGame2.get(key)!.push(r);
  }
  const games2 = [...byGame2.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const home = g.find((x) => x.homeAway === 'home') ?? g[0];
      const away = g.find((x) => x.team === home.opponent) ?? g[1];
      return { date: home.gameDate, home, away };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const results: Array<{ w: Weights; wr: number; wins: number; losses: number }> = [];

  for (const w of candidates) {
    const localHist = new Map<string, Row[]>();
    let wins = 0;
    let losses = 0;

    for (const game of games2) {
      const hHistDesc = [...(localHist.get(game.home.team) ?? [])].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());
      const aHistDesc = [...(localHist.get(game.away.team) ?? [])].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());
      const hf = teamForm(hHistDesc, standings);
      const af = teamForm(aHistDesc, standings);
      const hRest = daysOfRest(hHistDesc, game.date.getTime());
      const aRest = daysOfRest(aHistDesc, game.date.getTime());
      const restDiffHome = restEdgeBonus(hRest) - restEdgeBonus(aRest);
      const restDiffAway = -restDiffHome;

      const h = edgeParam(hf, af, restDiffHome, w);
      const a = edgeParam(af, hf, restDiffAway, w);
      const pick = h >= a ? game.home : game.away;

      if (pick.atsResult === 'W') wins += 1;
      else if (pick.atsResult === 'L') losses += 1;

      if (!localHist.has(game.home.team)) localHist.set(game.home.team, []);
      if (!localHist.has(game.away.team)) localHist.set(game.away.team, []);
      localHist.get(game.home.team)!.push(game.home);
      localHist.get(game.away.team)!.push(game.away);
    }

    const wr = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
    results.push({ w, wr: Number(wr.toFixed(2)), wins, losses });
  }

  results.sort((a, b) => b.wr - a.wr);
  console.log('Top 5 parameter sets (by ATS hit rate):');
  for (const r of results.slice(0, 5)) {
    console.log(JSON.stringify(r));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
