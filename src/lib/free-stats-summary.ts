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

function calibrateBestBetModel(rows: FreeStatLike[]) {
  const defaults = { momentumWeight: 20, atsWeight: 30, upsetWeight: 0.4, threshold: 62 };
  const byTeam = rows.reduce<Record<string, FreeStatLike[]>>((acc, row) => {
    if (!acc[row.team]) acc[row.team] = [];
    acc[row.team].push(row);
    return acc;
  }, {});

  let best = { ...defaults, score: -1 };

  for (let momentumWeight = 12; momentumWeight <= 28; momentumWeight += 4) {
    for (let atsWeight = 18; atsWeight <= 42; atsWeight += 6) {
      for (let upsetWeight = 0.2; upsetWeight <= 0.6; upsetWeight += 0.1) {
        for (let threshold = 55; threshold <= 72; threshold += 3) {
          let wins = 0;
          let losses = 0;
          let picks = 0;

          Object.values(byTeam).forEach((teamRows) => {
            const sorted = [...teamRows].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());
            for (let i = 3; i < sorted.length; i += 1) {
              const history = sorted.slice(i, i + 10);
              const game = sorted[i - 1];
              if (!history.length || (game.atsResult !== "W" && game.atsResult !== "L")) continue;
              const metrics = computeNcaabMetrics(history);
              const score = 50 + (metrics.last10Momentum ?? 0) * momentumWeight + ((metrics.atsForm ?? 0.5) - 0.5) * atsWeight + (metrics.upsetAlertScore - 50) * upsetWeight;
              if (score < threshold) continue;

              picks += 1;
              if (game.atsResult === "W") wins += 1;
              else losses += 1;
            }
          });

          if (picks < 20) continue;
          const hitRate = wins / Math.max(1, wins + losses);
          const objective = hitRate - Math.max(0, 40 - picks) * 0.001;
          if (objective > best.score) best = { momentumWeight, atsWeight, upsetWeight: Number(upsetWeight.toFixed(2)), threshold, score: objective };
        }
      }
    }
  }

  return {
    momentumWeight: best.momentumWeight,
    atsWeight: best.atsWeight,
    upsetWeight: best.upsetWeight,
    threshold: best.threshold,
    calibrated: best.score >= 0,
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
  const params = calibrateBestBetModel(ncaabRows);
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
          50 +
            (metrics.last10Momentum ?? 0) * params.momentumWeight +
            ((metrics.atsForm ?? 0.5) - 0.5) * params.atsWeight +
            (metrics.upsetAlertScore - 50) * params.upsetWeight,
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
    .filter((b) => b.score >= params.threshold)
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
    bestBetModel: params,
  };
}
