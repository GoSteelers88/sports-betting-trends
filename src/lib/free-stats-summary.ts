export type FreeStatLike = {
  league: string;
  conference: string | null;
  gameDate: Date;
  team: string;
  opponent: string;
  points: number;
  opponentPoints: number | null;
  rebounds: number | null;
  assists: number | null;
  yards: number | null;
  spread: number | null;
  atsResult: string | null;
  won: boolean | null;
  teamRank: number | null;
  opponentRank: number | null;
  bubbleStatus: string | null;
  autoBidStatus: string | null;
  source: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function avg(values: Array<number | null | undefined>) {
  const valid = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function trendScore(league: string, games: number, rows: FreeStatLike[]) {
  const latest = rows[0];
  if (!latest) return { score: 50, signal: "flat" as const, confidence: 0.35 };

  const avgPoints = avg(rows.map((r) => r.points));
  const pointBaseline = Math.max((avgPoints ?? latest.points) * 0.15, 5);
  const pointMomentum = clamp((latest.points - (avgPoints ?? latest.points)) / pointBaseline, -1, 1);

  let supportMomentum = 0;
  if (league === "NFL") {
    const avgYards = avg(rows.map((r) => r.yards));
    const yardsBase = Math.max((avgYards ?? latest.yards ?? 0) * 0.12, 25);
    supportMomentum =
      latest.yards == null ? 0 : clamp((latest.yards - (avgYards ?? latest.yards)) / yardsBase, -1, 1);
  } else {
    const avgReb = avg(rows.map((r) => r.rebounds));
    const avgAst = avg(rows.map((r) => r.assists));
    const rebBase = Math.max((avgReb ?? latest.rebounds ?? 0) * 0.18, 3);
    const astBase = Math.max((avgAst ?? latest.assists ?? 0) * 0.2, 2);
    const rebMomentum =
      latest.rebounds == null ? 0 : clamp((latest.rebounds - (avgReb ?? latest.rebounds)) / rebBase, -1, 1);
    const astMomentum =
      latest.assists == null ? 0 : clamp((latest.assists - (avgAst ?? latest.assists)) / astBase, -1, 1);
    supportMomentum = (rebMomentum + astMomentum) / 2;
  }

  const confidence = clamp(games / 10, 0.35, 1);
  const weighted = pointMomentum * 0.7 + supportMomentum * 0.3;
  const score = Math.round(clamp(50 + weighted * 35 * confidence, 1, 99));
  const signal = score >= 62 ? "up" : score <= 38 ? "down" : "flat";

  return { score, signal, confidence: Number(confidence.toFixed(2)) };
}

function groupByLeague(rows: FreeStatLike[]) {
  return rows.reduce<Record<string, FreeStatLike[]>>((acc, row) => {
    if (!acc[row.league]) acc[row.league] = [];
    acc[row.league].push(row);
    return acc;
  }, {});
}

function computeNcaabMetrics(rows: FreeStatLike[]) {
  const last10 = rows.slice(0, 10);
  const wins = last10.filter((r) => r.won === true).length;
  const losses = last10.filter((r) => r.won === false).length;
  const last10Momentum = last10.length ? Number(((wins - losses) / last10.length).toFixed(2)) : null;

  const atsGames = last10.filter((r) => r.atsResult === "W" || r.atsResult === "L");
  const atsWins = atsGames.filter((r) => r.atsResult === "W").length;
  const atsForm = atsGames.length ? Number((atsWins / atsGames.length).toFixed(2)) : null;

  const latest = rows[0];
  const latestMargin = latest?.opponentPoints == null ? 0 : latest.points - latest.opponentPoints;
  const asUnderdog = latest?.spread != null && latest.spread > 0;
  const vsRanked = (latest?.opponentRank ?? 999) <= 25;
  const upsetAlertScore = Math.round(
    clamp(
      25 +
        (asUnderdog ? 20 : 0) +
        (vsRanked ? 20 : 0) +
        clamp((latestMargin / 12) * 20, -10, 20) +
        clamp(((atsForm ?? 0.5) - 0.5) * 30, -10, 15) +
        clamp((last10Momentum ?? 0) * 30, -15, 20),
      1,
      99,
    ),
  );

  const bubbleTeams = new Set(rows.filter((r) => r.bubbleStatus === "BUBBLE").map((r) => r.team));
  const autoBidTeams = new Set(rows.filter((r) => r.autoBidStatus === "AUTO_BID").map((r) => r.team));

  return {
    last10Momentum,
    atsForm,
    upsetAlertScore,
    bubbleWatchTeams: [...bubbleTeams],
    autoBidWatchTeams: [...autoBidTeams],
  };
}

export function buildFreeStatsSummary(rows: FreeStatLike[]) {
  const sorted = [...rows].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());
  const byLeague = groupByLeague(sorted);

  const leagues = Object.entries(byLeague)
    .map(([league, leagueRows]) => {
      const recent = leagueRows.slice(0, 10);
      const trend = trendScore(league, leagueRows.length, recent);
      const conferences = [...new Set(leagueRows.map((r) => r.conference).filter(Boolean))] as string[];
      const ncaab = league === "NCAAB" ? computeNcaabMetrics(recent) : null;

      return {
        league,
        games: leagueRows.length,
        conferences,
        avgPoints: avg(leagueRows.map((r) => r.points)),
        avgRebounds: avg(leagueRows.map((r) => r.rebounds)),
        avgAssists: avg(leagueRows.map((r) => r.assists)),
        avgYards: avg(leagueRows.map((r) => r.yards)),
        recentAvgPoints: avg(recent.map((r) => r.points)),
        recentAvgYards: avg(recent.map((r) => r.yards)),
        trendScore: trend.score,
        trendSignal: trend.signal,
        confidence: trend.confidence,
        ncaab,
      };
    })
    .sort((a, b) => a.league.localeCompare(b.league));

  const latestByLeague = Object.values(byLeague)
    .map((leagueRows) => leagueRows[0])
    .filter(Boolean)
    .sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());

  const ncaabRows = sorted.filter((r) => r.league === "NCAAB");
  const byTeam = ncaabRows.reduce<Record<string, FreeStatLike[]>>((acc, row) => {
    if (!acc[row.team]) acc[row.team] = [];
    if (acc[row.team].length < 10) acc[row.team].push(row);
    return acc;
  }, {});

  const bestBets = Object.entries(byTeam)
    .map(([team, teamRows]) => {
      const metrics = computeNcaabMetrics(teamRows);
      const score = Math.round(
        clamp(
          50 + (metrics.last10Momentum ?? 0) * 20 + ((metrics.atsForm ?? 0.5) - 0.5) * 30 + (metrics.upsetAlertScore - 50) * 0.4,
          1,
          99,
        ),
      );

      return {
        league: "NCAAB",
        team,
        conference: teamRows[0]?.conference ?? null,
        score,
        last10Momentum: metrics.last10Momentum,
        atsForm: metrics.atsForm,
        upsetAlertScore: metrics.upsetAlertScore,
        bubbleStatus: teamRows[0]?.bubbleStatus ?? null,
        autoBidStatus: teamRows[0]?.autoBidStatus ?? null,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    ready: leagues.length > 0,
    recordsIngested: sorted.length,
    leagues,
    latestByLeague,
    conferences: [...new Set(ncaabRows.map((r) => r.conference).filter(Boolean))].sort(),
    bestBets,
  };
}
