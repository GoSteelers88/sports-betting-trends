import { prisma } from '../src/lib/prisma';
import { computeBasketballAdvanced, type BoxScoreRow, type StandingsEntry } from '../src/lib/advanced-metrics';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

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
  turnovers: number | null;
};

type TeamForm = {
  momentum: number;
  atsForm: number;
  margin: number;
  upsetProxy: number;
  netRating: number;
  sos: number;
  recentNet: number;
  seasonNet: number;
};

function toBox(r: Row): BoxScoreRow {
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

function std(values: number[]) {
  if (values.length < 2) return 1;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / values.length;
  return Math.max(1e-6, Math.sqrt(v));
}

function daysOfRest(histDesc: Row[], gameMs: number): number | null {
  const last = histDesc[0];
  if (!last) return null;
  return Math.round((gameMs - last.gameDate.getTime()) / 86400000);
}

function is3in4(histDesc: Row[], gameDate: Date): boolean {
  if (histDesc.length < 2) return false;
  const cutoff = gameDate.getTime() - 4 * 86400000;
  const recent = histDesc.filter((r) => r.gameDate.getTime() >= cutoff);
  return recent.length >= 2; // upcoming would be 3rd in 4
}

function modelSpreadBaseline(spread: number | null) {
  if (spread == null) return null;
  const abs = Math.abs(spread);
  const sign = spread < 0 ? -1 : 1;
  const regressed = abs <= 7 ? abs * 0.92 : 6.44 + (abs - 7) * 0.45;
  return Math.round(sign * regressed * 10) / 10;
}

function modelSpreadV2(spread: number | null) {
  if (spread == null) return null;
  const denom = 1 + 0.04 * Math.abs(spread);
  return Number((spread / denom).toFixed(2));
}

function restEdgeBonus(days: number | null) {
  if (days == null) return 0;
  if (days <= 1) return -4;
  if (days === 2) return -1.5;
  if (days >= 7) return 1.5;
  if (days >= 5) return 0.5;
  return 0;
}

function buildForm(histDesc: Row[], standings: StandingsEntry[]): TeamForm {
  const last10 = histDesc.slice(0, 10);
  if (!last10.length) return { momentum: 0, atsForm: 0.5, margin: 0, upsetProxy: 50, netRating: 0, sos: 0.5, recentNet: 0, seasonNet: 0 };

  const wins = last10.filter((r) => r.won === true).length;
  const losses = last10.filter((r) => r.won === false).length;
  const momentum = last10.length ? (wins - losses) / last10.length : 0;

  const atsGames = last10.filter((r) => r.atsResult === 'W' || r.atsResult === 'L');
  const atsWins = atsGames.filter((r) => r.atsResult === 'W').length;
  const atsForm = atsGames.length ? atsWins / atsGames.length : 0.5;

  const margins = last10.filter((r) => r.opponentPoints != null).map((r) => r.points - (r.opponentPoints as number));
  const margin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
  const upsetProxy = Math.round(clamp(50 + margin * 7 + ((atsForm - 0.5) * 25), 1, 99));

  const recentAdv = computeBasketballAdvanced(last10.map(toBox), standings);
  const seasonAdv = computeBasketballAdvanced(histDesc.map(toBox), standings);

  return {
    momentum,
    atsForm,
    margin,
    upsetProxy,
    netRating: recentAdv.netRating ?? 0,
    sos: recentAdv.sos ?? 0.5,
    recentNet: recentAdv.netRating ?? 0,
    seasonNet: seasonAdv.netRating ?? recentAdv.netRating ?? 0,
  };
}

function evalWindow(records: any[], days: number, now: Date) {
  const cutoff = new Date(now.getTime() - days * 86400000);
  const rows = records.filter((r) => r.date >= cutoff);
  const out = (k: 'base' | 'all') => {
    const picks = rows.map((r) => r[k]);
    const wins = picks.filter((p: any) => p.res === 'W').length;
    const losses = picks.filter((p: any) => p.res === 'L').length;
    const pushes = picks.filter((p: any) => p.res === 'P').length;
    return { wins, losses, pushes, wr: Number(((wins / Math.max(1, wins + losses)) * 100).toFixed(2)) };
  };
  return { days, sample: rows.length, baseline: out('base'), upgraded: out('all') };
}

async function main() {
  const standingsPath = path.join(root, 'data', 'processed', 'standings-nba.json');
  const standings: StandingsEntry[] = fs.existsSync(standingsPath)
    ? JSON.parse(fs.readFileSync(standingsPath, 'utf8'))
    : [];

  const now = new Date();
  const rows = (await prisma.freeStat.findMany({
    where: { league: 'NBA', gameDate: { lt: now }, opponentPoints: { not: null } },
    orderBy: { gameDate: 'asc' },
    select: {
      gameDate: true, team: true, opponent: true, points: true, opponentPoints: true,
      spread: true, atsResult: true, won: true, homeAway: true,
      fgm: true, fga: true, threepm: true, threepa: true, ftm: true, fta: true,
      offRebounds: true, defRebounds: true, turnovers: true,
    },
  })) as Row[];

  const valid = rows.filter((r) => r.atsResult === 'W' || r.atsResult === 'L' || r.atsResult === 'P');
  const byGame = new Map<string, Row[]>();
  for (const r of valid) {
    const key = `${r.gameDate.toISOString()}|${[r.team, r.opponent].sort().join('|')}`;
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key)!.push(r);
  }

  const games = [...byGame.values()].filter((g) => g.length >= 2).map((g) => {
    const home = g.find((x) => x.homeAway === 'home') ?? g[0];
    const away = g.find((x) => x.team === home.opponent) ?? g[1];
    return { date: home.gameDate, home, away };
  }).sort((a,b)=>a.date.getTime()-b.date.getTime());

  const hist = new Map<string, Row[]>();
  const recs: any[] = [];

  for (const g of games) {
    const homeHist = [...(hist.get(g.home.team) ?? [])].sort((a,b)=>b.gameDate.getTime()-a.gameDate.getTime());
    const awayHist = [...(hist.get(g.away.team) ?? [])].sort((a,b)=>b.gameDate.getTime()-a.gameDate.getTime());

    const hf = buildForm(homeHist, standings);
    const af = buildForm(awayHist, standings);

    // league stds (from historical known rows only)
    const leagueMargins = [...homeHist, ...awayHist].filter(r => r.opponentPoints!=null).map(r => r.points - (r.opponentPoints as number));
    const leagueStdMargin = std(leagueMargins.length ? leagueMargins : [10]);
    const leagueNets = [hf.recentNet, af.recentNet, hf.seasonNet, af.seasonNet];
    const leagueStdNet = std(leagueNets.length ? leagueNets : [5]);

    // baseline edge (current-ish)
    const baseHome = hf.momentum * 22 + ((hf.atsForm - 0.5) * 26) + ((hf.upsetProxy - af.upsetProxy) * 0.3) + ((hf.netRating - af.netRating) * 0.5) + ((hf.sos - af.sos) * 15);
    const baseAway = af.momentum * 22 + ((af.atsForm - 0.5) * 26) + ((af.upsetProxy - hf.upsetProxy) * 0.3) + ((af.netRating - hf.netRating) * 0.5) + ((af.sos - hf.sos) * 15);
    const pickBaseHome = baseHome >= baseAway;
    const pickBase = pickBaseHome ? g.home : g.away;

    // upgraded formulas bundle (#1-10, with travel miles unavailable=>0)
    const homeRecentMargin = hf.margin;
    const awayRecentMargin = af.margin;

    const homeShrunkMomentum = 0.35 * hf.momentum + 0.65 * (hf.recentNet / leagueStdNet);
    const awayShrunkMomentum = 0.35 * af.momentum + 0.65 * (af.recentNet / leagueStdNet);
    const homeMomentumAdj = homeShrunkMomentum * 12;
    const awayMomentumAdj = awayShrunkMomentum * 12;

    const homeBlendedAts = 0.5 + ((hf.atsForm - 0.5) * 0.35) + ((hf.atsForm - 0.5) * 0.25); // scraped unavailable in offline backtest
    const awayBlendedAts = 0.5 + ((af.atsForm - 0.5) * 0.35) + ((af.atsForm - 0.5) * 0.25);
    const homeAtsAdj = (homeBlendedAts - 0.5) * 12;
    const awayAtsAdj = (awayBlendedAts - 0.5) * 12;

    const homeUpsetV2 = 50 + (homeRecentMargin / leagueStdMargin) * 8;
    const awayUpsetV2 = 50 + (awayRecentMargin / leagueStdMargin) * 8;

    const homeShrunkNet = (0.7 * hf.seasonNet) + (0.3 * hf.recentNet);
    const awayShrunkNet = (0.7 * af.seasonNet) + (0.3 * af.recentNet);

    const homeRestDays = daysOfRest(homeHist, g.date.getTime());
    const awayRestDays = daysOfRest(awayHist, g.date.getTime());
    const restDiffHome = (homeRestDays ?? 3) - (awayRestDays ?? 3);
    const restDiffAway = -restDiffHome;

    const homeB2B = (homeRestDays ?? 3) <= 1 ? 1 : 0;
    const awayB2B = (awayRestDays ?? 3) <= 1 ? 1 : 0;
    const home3in4 = is3in4(homeHist, g.date) ? 1 : 0;
    const away3in4 = is3in4(awayHist, g.date) ? 1 : 0;

    const homeRestAdj = 1.4 * restDiffHome - 1.2 * homeB2B - 0.6 * home3in4;
    const awayRestAdj = 1.4 * restDiffAway - 1.2 * awayB2B - 0.6 * away3in4;

    const homeHomeAdj = 2.2 + 0.4 * (restEdgeBonus(homeRestDays) - restEdgeBonus(awayRestDays)) + 0; // travel miles unavailable
    const awayHomeAdj = -(2.2 + 0.4 * (restEdgeBonus(homeRestDays) - restEdgeBonus(awayRestDays)) + 0);

    const edgeHomeAll =
      homeMomentumAdj +
      homeAtsAdj +
      0.7 * (homeShrunkNet - awayShrunkNet) +
      10 * (hf.sos - af.sos) +
      homeRestAdj +
      homeHomeAdj +
      0.4 * (homeUpsetV2 - awayUpsetV2);

    const edgeAwayAll =
      awayMomentumAdj +
      awayAtsAdj +
      0.7 * (awayShrunkNet - homeShrunkNet) +
      10 * (af.sos - hf.sos) +
      awayRestAdj +
      awayHomeAdj +
      0.4 * (awayUpsetV2 - homeUpsetV2);

    const pickAllHome = edgeHomeAll >= edgeAwayAll;
    const pickAll = pickAllHome ? g.home : g.away;

    // scoring formulas included but not used for W/L selection output
    const pickedSpread = (pickAllHome ? g.home.spread : g.away.spread);
    const _modelSpread = modelSpreadV2(pickedSpread) ?? modelSpreadBaseline(pickedSpread);
    const _rawScoreAll = 50 + 14 * Math.tanh((Math.max(edgeHomeAll, edgeAwayAll)) / 6);
    const _confAll = 0.42 + 0.55 * sigmoid(Math.abs(Math.max(edgeHomeAll, edgeAwayAll)) / 5);

    recs.push({
      date: g.date,
      base: { team: pickBase.team, res: pickBase.atsResult },
      all: { team: pickAll.team, res: pickAll.atsResult },
    });

    if (!hist.has(g.home.team)) hist.set(g.home.team, []);
    if (!hist.has(g.away.team)) hist.set(g.away.team, []);
    hist.get(g.home.team)!.push(g.home);
    hist.get(g.away.team)!.push(g.away);
  }

  console.log(`Total games: ${recs.length}`);
  for (const d of [30, 60, 90]) {
    console.log(JSON.stringify(evalWindow(recs, d, now), null, 2));
  }
}

main().finally(async () => {
  await prisma.$disconnect();
});
