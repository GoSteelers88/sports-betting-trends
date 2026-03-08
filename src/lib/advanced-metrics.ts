export type StandingsEntry = {
  team: string;
  abbreviation: string;
  wins: number;
  losses: number;
  winPct: number;
  conference?: string;
};

export type BoxScoreRow = {
  team: string;
  opponent: string;
  points: number;
  opponentPoints: number | null;
  fgm: number | null;
  fga: number | null;
  threepm: number | null;
  threepa: number | null;
  ftm: number | null;
  fta: number | null;
  offRebounds: number | null;
  defRebounds: number | null;
  turnovers: number | null;
  // NFL
  passingYards: number | null;
  rushingYards: number | null;
  opponentYards: number | null;
  turnoversFor: number | null;
  turnoversAgainst: number | null;
  thirdDownConv: number | null;
  thirdDownAtt: number | null;
  redZoneConv: number | null;
  redZoneAtt: number | null;
  timeOfPossession: number | null;
  // MLB
  hits: number | null;
  errors: number | null;
};

export type BasketballAdvanced = {
  games: number;
  pace: number | null;
  oRtg: number | null;
  dRtg: number | null;
  netRating: number | null;
  tsPct: number | null;
  efgPct: number | null;
  toRate: number | null;
  ftRate: number | null;
  sos: number | null;
};

export type FootballAdvanced = {
  games: number;
  ppg: number | null;
  oppPpg: number | null;
  ypg: number | null;
  oppYpg: number | null;
  turnoverMargin: number | null;
  thirdDownPct: number | null;
  redZonePct: number | null;
  avgTop: number | null;
  sos: number | null;
};

export type BaseballAdvanced = {
  games: number;
  rpg: number | null;
  oppRpg: number | null;
  hitsPerGame: number | null;
  errorsPerGame: number | null;
  sos: number | null;
};

export type HockeyAdvanced = {
  games: number;
  gpg: number | null;
  gapg: number | null;
  spg: number | null;
  savePct: number | null;
  sos: number | null;
};

export type SoccerAdvanced = {
  games: number;
  gpg: number | null;
  gapg: number | null;
  cleanSheetsPct: number | null;
  sos: number | null;
};

function safeDiv(num: number, den: number): number | null {
  if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return num / den;
}

function sumNonNull(values: (number | null | undefined)[]): number | null {
  const valid = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0);
}

function avgNonNull(values: (number | null | undefined)[]): number | null {
  const valid = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function round2(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function computeSos(opponents: string[], standings: StandingsEntry[]): number | null {
  if (!opponents.length || !standings.length) return null;
  const byName = new Map<string, StandingsEntry>();
  for (const s of standings) {
    byName.set(s.team.toLowerCase(), s);
    byName.set(s.abbreviation.toLowerCase(), s);
  }

  let total = 0;
  let count = 0;
  for (const opp of opponents) {
    const entry = byName.get(opp.toLowerCase());
    if (entry) {
      total += entry.winPct;
      count += 1;
    }
  }
  return count > 0 ? round2(total / count) : null;
}

export function computeBasketballAdvanced(
  teamRows: BoxScoreRow[],
  standings: StandingsEntry[],
): BasketballAdvanced {
  const games = teamRows.length;
  if (!games) {
    return { games: 0, pace: null, oRtg: null, dRtg: null, netRating: null, tsPct: null, efgPct: null, toRate: null, ftRate: null, sos: null };
  }

  const totalFga = sumNonNull(teamRows.map((r) => r.fga)) ?? 0;
  const totalFta = sumNonNull(teamRows.map((r) => r.fta)) ?? 0;
  const totalOrb = sumNonNull(teamRows.map((r) => r.offRebounds)) ?? 0;
  const totalTo = sumNonNull(teamRows.map((r) => r.turnovers)) ?? 0;
  const totalFgm = sumNonNull(teamRows.map((r) => r.fgm)) ?? 0;
  const total3pm = sumNonNull(teamRows.map((r) => r.threepm)) ?? 0;
  const totalPts = teamRows.reduce((s, r) => s + r.points, 0);
  const totalOppPts = sumNonNull(teamRows.map((r) => r.opponentPoints)) ?? 0;

  // Pace = FGA + 0.44 * FTA - ORB + TO (per game estimate of possessions)
  const hasShotData = teamRows.some((r) => r.fga != null);
  const totalPossessions = hasShotData ? totalFga + 0.44 * totalFta - totalOrb + totalTo : 0;
  const pace = hasShotData ? round2(totalPossessions / games) : null;

  const oRtg = totalPossessions > 0 ? round2((totalPts / totalPossessions) * 100) : null;
  const dRtg = totalPossessions > 0 ? round2((totalOppPts / totalPossessions) * 100) : null;
  const netRating = oRtg != null && dRtg != null ? round2(oRtg - dRtg) : null;

  // TS% = PTS / (2 * (FGA + 0.44 * FTA))
  const tsaDenom = 2 * (totalFga + 0.44 * totalFta);
  const tsPct = hasShotData && tsaDenom > 0 ? round2(totalPts / tsaDenom) : null;

  // eFG% = (FGM + 0.5 * 3PM) / FGA
  const efgPct = hasShotData && totalFga > 0 ? round2((totalFgm + 0.5 * total3pm) / totalFga) : null;

  // TO Rate = TO / possessions
  const toRate = totalPossessions > 0 ? round2(totalTo / totalPossessions) : null;

  // FT Rate = FTA / FGA
  const ftRate = hasShotData && totalFga > 0 ? round2(totalFta / totalFga) : null;

  const opponents = teamRows.map((r) => r.opponent);
  const sos = computeSos(opponents, standings);

  return { games, pace, oRtg, dRtg, netRating, tsPct, efgPct, toRate, ftRate, sos };
}

export function computeFootballAdvanced(
  teamRows: BoxScoreRow[],
  standings: StandingsEntry[],
): FootballAdvanced {
  const games = teamRows.length;
  if (!games) {
    return { games: 0, ppg: null, oppPpg: null, ypg: null, oppYpg: null, turnoverMargin: null, thirdDownPct: null, redZonePct: null, avgTop: null, sos: null };
  }

  const ppg = round2(teamRows.reduce((s, r) => s + r.points, 0) / games);
  const oppPpg = round2((sumNonNull(teamRows.map((r) => r.opponentPoints)) ?? 0) / games);

  const totalPassYds = sumNonNull(teamRows.map((r) => r.passingYards)) ?? 0;
  const totalRushYds = sumNonNull(teamRows.map((r) => r.rushingYards)) ?? 0;
  const hasYards = teamRows.some((r) => r.passingYards != null || r.rushingYards != null);
  const ypg = hasYards ? round2((totalPassYds + totalRushYds) / games) : null;

  const oppYpg = round2((sumNonNull(teamRows.map((r) => r.opponentYards)) ?? 0) / games);

  const totalTOfor = sumNonNull(teamRows.map((r) => r.turnoversFor)) ?? 0;
  const totalTOagainst = sumNonNull(teamRows.map((r) => r.turnoversAgainst)) ?? 0;
  const hasTurnoverData = teamRows.some((r) => r.turnoversFor != null || r.turnoversAgainst != null);
  const turnoverMargin = hasTurnoverData ? round2((totalTOfor - totalTOagainst) / games) : null;

  const total3dConv = sumNonNull(teamRows.map((r) => r.thirdDownConv)) ?? 0;
  const total3dAtt = sumNonNull(teamRows.map((r) => r.thirdDownAtt)) ?? 0;
  const thirdDownPct = total3dAtt > 0 ? round2(total3dConv / total3dAtt) : null;

  const totalRzConv = sumNonNull(teamRows.map((r) => r.redZoneConv)) ?? 0;
  const totalRzAtt = sumNonNull(teamRows.map((r) => r.redZoneAtt)) ?? 0;
  const redZonePct = totalRzAtt > 0 ? round2(totalRzConv / totalRzAtt) : null;

  const topValues = teamRows.map((r) => r.timeOfPossession).filter((v): v is number => v != null);
  const avgTop = topValues.length ? round2(topValues.reduce((s, v) => s + v, 0) / topValues.length) : null;

  const opponents = teamRows.map((r) => r.opponent);
  const sos = computeSos(opponents, standings);

  return { games, ppg, oppPpg, ypg, oppYpg, turnoverMargin, thirdDownPct, redZonePct, avgTop, sos };
}

export function computeBaseballAdvanced(
  teamRows: BoxScoreRow[],
  standings: StandingsEntry[],
): BaseballAdvanced {
  const games = teamRows.length;
  if (!games) {
    return { games: 0, rpg: null, oppRpg: null, hitsPerGame: null, errorsPerGame: null, sos: null };
  }

  const rpg = round2(teamRows.reduce((s, r) => s + r.points, 0) / games);
  const oppRpg = round2((sumNonNull(teamRows.map((r) => r.opponentPoints)) ?? 0) / games);
  const hitsPerGame = round2((sumNonNull(teamRows.map((r) => r.hits)) ?? 0) / games);
  const errorsPerGame = round2((sumNonNull(teamRows.map((r) => r.errors)) ?? 0) / games);

  const opponents = teamRows.map((r) => r.opponent);
  const sos = computeSos(opponents, standings);

  return { games, rpg, oppRpg, hitsPerGame, errorsPerGame, sos };
}

export function computeHockeyAdvanced(
  teamRows: BoxScoreRow[],
  standings: StandingsEntry[],
): HockeyAdvanced {
  const games = teamRows.length;
  if (!games) {
    return { games: 0, gpg: null, gapg: null, spg: null, savePct: null, sos: null };
  }

  // points = goals scored; opponentPoints = goals against
  // offRebounds reused as shots faced (for save %); defRebounds reused as shots for
  const gpg = round2(teamRows.reduce((s, r) => s + r.points, 0) / games);
  const gapg = round2((sumNonNull(teamRows.map((r) => r.opponentPoints)) ?? 0) / games);

  // defRebounds stores shots on goal (for the team); offRebounds stores shots faced
  const totalShots = sumNonNull(teamRows.map((r) => r.defRebounds));
  const spg = totalShots != null ? round2(totalShots / games) : null;

  // savePct: (shots faced - goals against) / shots faced
  const totalShotsFaced = sumNonNull(teamRows.map((r) => r.offRebounds));
  const totalGoalsAgainst = sumNonNull(teamRows.map((r) => r.opponentPoints)) ?? 0;
  const savePct =
    totalShotsFaced != null && totalShotsFaced > 0
      ? round2((totalShotsFaced - totalGoalsAgainst) / totalShotsFaced)
      : null;

  const opponents = teamRows.map((r) => r.opponent);
  const sos = computeSos(opponents, standings);

  return { games, gpg, gapg, spg, savePct, sos };
}

export function computeSoccerAdvanced(
  teamRows: BoxScoreRow[],
  standings: StandingsEntry[],
): SoccerAdvanced {
  const games = teamRows.length;
  if (!games) {
    return { games: 0, gpg: null, gapg: null, cleanSheetsPct: null, sos: null };
  }

  const gpg = round2(teamRows.reduce((s, r) => s + r.points, 0) / games);
  const gapg = round2((sumNonNull(teamRows.map((r) => r.opponentPoints)) ?? 0) / games);

  // Clean sheet = opponent scored 0 goals
  const cleanSheets = teamRows.filter((r) => r.opponentPoints === 0).length;
  const cleanSheetsPct = round2(cleanSheets / games);

  const opponents = teamRows.map((r) => r.opponent);
  const sos = computeSos(opponents, standings);

  return { games, gpg, gapg, cleanSheetsPct, sos };
}
