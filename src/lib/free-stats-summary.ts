import {
  computeBasketballAdvanced,
  computeFootballAdvanced,
  computeBaseballAdvanced,
  type StandingsEntry,
  type BoxScoreRow,
  type BasketballAdvanced,
  type FootballAdvanced,
  type BaseballAdvanced,
} from "./advanced-metrics";

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
  sourceEventId?: string | null;
  gameStatus?: string | null;
  completionEvidence?: string | null;
  // Box score (basketball)
  fgm?: number | null;
  fga?: number | null;
  threepm?: number | null;
  threepa?: number | null;
  ftm?: number | null;
  fta?: number | null;
  offRebounds?: number | null;
  defRebounds?: number | null;
  steals?: number | null;
  blocks?: number | null;
  turnovers?: number | null;
  // NFL box score
  passingYards?: number | null;
  rushingYards?: number | null;
  opponentYards?: number | null;
  turnoversFor?: number | null;
  turnoversAgainst?: number | null;
  thirdDownConv?: number | null;
  thirdDownAtt?: number | null;
  redZoneConv?: number | null;
  redZoneAtt?: number | null;
  timeOfPossession?: number | null;
  // Universal
  homeAway?: string | null;
  hits?: number | null;
  errors?: number | null;
};

export type InjuryEntry = {
  player: string;
  team: string;
  position: string;
  status: string;
  injuryType: string;
  returnDate: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// Regress large market spreads toward a realistic predicted margin.
// Small spreads (≤7) get a minor 8% haircut. Larger spreads are progressively
// compressed: -10 → -7.8, -15 → -10.0, -22 → -13.2.
function regressionSpread(marketSpread: number | null): number | null {
  if (marketSpread == null) return null;
  const abs = Math.abs(marketSpread);
  const sign = marketSpread < 0 ? -1 : 1;
  const regressed = abs <= 7 ? abs * 0.92 : 6.44 + (abs - 7) * 0.45;
  return Math.round(sign * regressed * 10) / 10;
}

// ── Contextual adjustment helpers ──────────────────────────────────────────

// Home advantage in composite score points by league (research-backed estimates)
const HOME_ADVANTAGE_PTS: Record<string, number> = {
  NBA: 2.5,
  NFL: 2.5,
  NCAAB: 3.5,
  MLB: 1.0,
};

// Days between the team's most recent completed game and the upcoming game
function daysOfRest(sortedHistory: FreeStatLike[], upcomingMs: number): number | null {
  const lastGame = sortedHistory[0];
  if (!lastGame) return null;
  return Math.round((upcomingMs - lastGame.gameDate.getTime()) / 86400000);
}

// Score bonus for rest situation. Negative = fatigue, positive = well rested.
function restEdgeBonus(days: number | null): number {
  if (days == null) return 0;
  if (days <= 1) return -4;    // back-to-back: significant fatigue
  if (days === 2) return -1.5; // short rest
  if (days >= 7) return 1.5;   // well rested
  if (days >= 5) return 0.5;   // slightly fresh
  return 0;                     // 3-4 days: normal
}

// Injury penalty in score points for a team. High-impact positions weighted more.
function injuryEdgePenalty(team: string, injuries: InjuryEntry[], league: string): number {
  const HIGH_IMPACT_POSITIONS: Record<string, string[]> = {
    NFL: ["QB"],
    NBA: ["C", "PF", "PG"],
  };
  const highPos = HIGH_IMPACT_POSITIONS[league] ?? [];
  const teamLc = team.toLowerCase();
  const relevant = injuries.filter((inj) => {
    const injTeam = inj.team.toLowerCase();
    return injTeam.includes(teamLc) || teamLc.includes(injTeam);
  });
  let penalty = 0;
  for (const inj of relevant) {
    const s = inj.status.toUpperCase();
    const isHigh = highPos.some((p) => inj.position.toUpperCase().includes(p));
    const base = s.includes("OUT") ? 1.5 : s.includes("DOUBTFUL") ? 0.8 : s.includes("QUESTIONABLE") ? 0.4 : 0;
    penalty += isHigh ? base * 3 : base;
  }
  return Math.min(penalty, 8); // cap at 8 pts
}

// Bookmaker consensus: avg spread + variance across books (proxy for line movement / market certainty)
function bookmakerConsensus(event: OddsEventLike, team: string): { avg: number | null; variance: number; bookCount: number } {
  const points = (event.bookmakers ?? [])
    .flatMap((b) => b.markets ?? [])
    .filter((m) => m.key === "spreads")
    .flatMap((m) => m.outcomes ?? [])
    .filter((o) => o.name === team)
    .map((o) => o.point)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  if (!points.length) return { avg: null, variance: 0, bookCount: 0 };
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  const variance = points.length > 1
    ? points.reduce((s, p) => s + (p - mean) ** 2, 0) / points.length
    : 0;
  return { avg: Math.round(mean * 10) / 10, variance: Math.round(variance * 100) / 100, bookCount: points.length };
}

// ───────────────────────────────────────────────────────────────────────────

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

function groupByTeam(rows: FreeStatLike[]) {
  return rows.reduce<Record<string, FreeStatLike[]>>((acc, row) => {
    if (!acc[row.team]) acc[row.team] = [];
    acc[row.team].push(row);
    return acc;
  }, {});
}

function normalizeStatus(status?: string | null) {
  return (status ?? "").trim().toUpperCase();
}

function statusSuggestsCompleted(status?: string | null) {
  const s = normalizeStatus(status);
  if (!s) return false;
  return s.includes("FINAL") || s.includes("POST") || s.includes("COMPLETE") || s.includes("COMPLETED");
}

function statusSuggestsIncomplete(status?: string | null) {
  const s = normalizeStatus(status);
  if (!s) return false;
  return s.includes("SCHEDULED") || s.includes("PRE") || s.includes("LIVE") || s.includes("IN_PROGRESS");
}

function inferCompletionEvidence(row: FreeStatLike) {
  if (row.completionEvidence) return row.completionEvidence;
  if (row.won != null) return "won-field";
  if (row.atsResult === "W" || row.atsResult === "L" || row.atsResult === "P") return "ats-result";
  if (row.opponentPoints != null) return "has-opponent-points";
  if (row.yards != null) return "has-yards";
  if (row.rebounds != null || row.assists != null) return "has-boxscore-stats";
  if (Number.isFinite(row.points) && row.points > 0) return "has-points";
  return null;
}

function isCompletedGame(row: FreeStatLike, nowMs: number) {
  const gameMs = row.gameDate.getTime();
  if (gameMs > nowMs) return false;

  const explicitCompleted = statusSuggestsCompleted(row.gameStatus);
  const evidence = inferCompletionEvidence(row);

  if (statusSuggestsIncomplete(row.gameStatus)) return false;
  return explicitCompleted || evidence != null;
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

type TeamForm = {
  momentum: number;
  atsForm: number | null;
  upsetProxy: number;
  netRating: number | null;
  sos: number | null;
  turnoverMargin: number | null;
};

type BestBetGame = {
  league: string;
  conference: string | null;
  gameDate: Date;
  matchup: string;
  pickTeam: string;
  opponent: string;
  spread: number | null;
  modelSpread: number | null;
  line: string | null;
  score: number;
  confidence: number;
  rationaleSignals: string[];
  momentumEdge: number;
  atsEdge: number | null;
};

type OddsEventLike = {
  id?: string;
  sport_key?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: Array<{
    markets?: Array<{
      key?: string;
      outcomes?: Array<{ name?: string; point?: number }>;
    }>;
  }>;
};

function dayKeyInEt(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function gameKey(row: FreeStatLike) {
  const a = row.team.localeCompare(row.opponent) <= 0 ? row.team : row.opponent;
  const b = row.team.localeCompare(row.opponent) <= 0 ? row.opponent : row.team;
  const event = row.sourceEventId ?? "";
  return `${row.league}|${dayKeyInEt(row.gameDate)}|${a}|${b}|${event}`;
}

function toBoxScoreRow(r: FreeStatLike): BoxScoreRow {
  return {
    team: r.team,
    opponent: r.opponent,
    points: r.points,
    opponentPoints: r.opponentPoints ?? null,
    fgm: r.fgm ?? null,
    fga: r.fga ?? null,
    threepm: r.threepm ?? null,
    threepa: r.threepa ?? null,
    ftm: r.ftm ?? null,
    fta: r.fta ?? null,
    offRebounds: r.offRebounds ?? null,
    defRebounds: r.defRebounds ?? null,
    turnovers: r.turnovers ?? null,
    passingYards: r.passingYards ?? null,
    rushingYards: r.rushingYards ?? null,
    opponentYards: r.opponentYards ?? null,
    turnoversFor: r.turnoversFor ?? null,
    turnoversAgainst: r.turnoversAgainst ?? null,
    thirdDownConv: r.thirdDownConv ?? null,
    thirdDownAtt: r.thirdDownAtt ?? null,
    redZoneConv: r.redZoneConv ?? null,
    redZoneAtt: r.redZoneAtt ?? null,
    timeOfPossession: r.timeOfPossession ?? null,
    hits: r.hits ?? null,
    errors: r.errors ?? null,
  };
}

function computeTeamForm(league: string, rows: FreeStatLike[], standings?: StandingsEntry[]): TeamForm {
  if (!rows.length) return { momentum: 0, atsForm: null, upsetProxy: 50, netRating: null, sos: null, turnoverMargin: null };

  if (league === "NCAAB") {
    const m = computeNcaabMetrics(rows);
    const boxRows = rows.map(toBoxScoreRow);
    const adv = computeBasketballAdvanced(boxRows, standings ?? []);
    return {
      momentum: m.last10Momentum ?? 0,
      atsForm: m.atsForm,
      upsetProxy: m.upsetAlertScore,
      netRating: adv.netRating,
      sos: adv.sos,
      turnoverMargin: null,
    };
  }

  const last10 = rows.slice(0, 10);
  const wins = last10.filter((r) => r.won === true).length;
  const losses = last10.filter((r) => r.won === false).length;
  const momentum = last10.length ? Number(((wins - losses) / last10.length).toFixed(2)) : 0;

  const atsGames = last10.filter((r) => r.atsResult === "W" || r.atsResult === "L");
  const atsWins = atsGames.filter((r) => r.atsResult === "W").length;
  const atsForm = atsGames.length ? Number((atsWins / atsGames.length).toFixed(2)) : null;

  const margin = avg(last10.map((r) => (r.opponentPoints == null ? null : r.points - r.opponentPoints))) ?? 0;
  const upsetProxy = Math.round(clamp(50 + margin * 7 + ((atsForm ?? 0.5) - 0.5) * 25, 1, 99));

  const boxRows = last10.map(toBoxScoreRow);
  let netRating: number | null = null;
  let sos: number | null = null;
  let turnoverMargin: number | null = null;

  if (league === "NBA") {
    const adv = computeBasketballAdvanced(boxRows, standings ?? []);
    netRating = adv.netRating;
    sos = adv.sos;
  } else if (league === "NFL") {
    const adv = computeFootballAdvanced(boxRows, standings ?? []);
    netRating = adv.ppg != null && adv.oppPpg != null ? Math.round((adv.ppg - adv.oppPpg) * 100) / 100 : null;
    sos = adv.sos;
    turnoverMargin = adv.turnoverMargin;
  } else if (league === "MLB") {
    const adv = computeBaseballAdvanced(boxRows, standings ?? []);
    netRating = adv.rpg != null && adv.oppRpg != null ? Math.round((adv.rpg - adv.oppRpg) * 100) / 100 : null;
    sos = adv.sos;
  }

  return { momentum, atsForm, upsetProxy, netRating, sos, turnoverMargin };
}

function buildGameLevelBestBets(allRows: FreeStatLike[], completedRows: FreeStatLike[], standings?: Record<string, StandingsEntry[]>, injuries?: Record<string, InjuryEntry[]>, nbaEfficiency?: NbaEfficiencyData) {
  if (!allRows.length) return [] as BestBetGame[];

  const todayEt = dayKeyInEt(new Date());
  const todaysRows = allRows.filter((row) => dayKeyInEt(row.gameDate) === todayEt);

  const historyByTeam = completedRows.reduce<Record<string, FreeStatLike[]>>((acc, row) => {
    const key = `${row.league}|${row.team}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  Object.values(historyByTeam).forEach((rows) => rows.sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime()));

  const byGame = todaysRows.reduce<Record<string, FreeStatLike[]>>((acc, row) => {
    const key = gameKey(row);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  return Object.values(byGame)
    .map((rowsForGame) => {
      const sides = rowsForGame
        .slice()
        .sort((a, b) => a.team.localeCompare(b.team))
        .filter((row, idx, arr) => arr.findIndex((x) => x.team === row.team) === idx)
        .slice(0, 2);

      const primary = sides[0];
      if (!primary) return null;

      const other = sides.find((s) => s.team === primary.opponent) ?? sides[1] ?? null;
      const leagueStandings = standings?.[primary.league.toLowerCase()] ?? standings?.[primary.league] ?? [];
      const pickHistory = (historyByTeam[`${primary.league}|${primary.team}`] ?? []).filter(
        (r) => r.gameDate.getTime() < primary.gameDate.getTime(),
      );
      const oppHistory = other
        ? (historyByTeam[`${other.league}|${other.team}`] ?? []).filter((r) => r.gameDate.getTime() < primary.gameDate.getTime())
        : [];

      const aForm = computeTeamForm(primary.league, pickHistory.slice(0, 10), leagueStandings);
      const bForm = computeTeamForm(primary.league, oppHistory.slice(0, 10), leagueStandings);

      let pick = primary;
      let pickForm = aForm;
      let oppForm = bForm;

      // Enhanced edge calculation with net rating and SOS
      const netRatingBonus = (form: TeamForm, oppF: TeamForm) => {
        if (form.netRating != null && oppF.netRating != null) return (form.netRating - oppF.netRating) * 0.5;
        return 0;
      };
      const sosBonus = (form: TeamForm, oppF: TeamForm) => {
        if (form.sos != null && oppF.sos != null) return (form.sos - oppF.sos) * 15;
        return 0;
      };
      const toMarginBonus = (form: TeamForm, oppF: TeamForm) => {
        if (form.turnoverMargin != null && oppF.turnoverMargin != null) return (form.turnoverMargin - oppF.turnoverMargin) * 8;
        return 0;
      };

      const edgeAB = aForm.momentum * 22 + ((aForm.atsForm ?? 0.5) - 0.5) * 26 + (aForm.upsetProxy - bForm.upsetProxy) * 0.3
        + netRatingBonus(aForm, bForm) + sosBonus(aForm, bForm) + toMarginBonus(aForm, bForm);
      const edgeBA = bForm.momentum * 22 + ((bForm.atsForm ?? 0.5) - 0.5) * 26 + (bForm.upsetProxy - aForm.upsetProxy) * 0.3
        + netRatingBonus(bForm, aForm) + sosBonus(bForm, aForm) + toMarginBonus(bForm, aForm);

      if (other && edgeBA > edgeAB) {
        pick = other;
        pickForm = bForm;
        oppForm = aForm;
      }

      const momentumEdge = Number((pickForm.momentum - oppForm.momentum).toFixed(2));
      const atsEdge =
        pickForm.atsForm == null || oppForm.atsForm == null
          ? null
          : Number((pickForm.atsForm - oppForm.atsForm).toFixed(2));

      const rawScore =
        56 +
        momentumEdge * 24 +
        ((pickForm.atsForm ?? 0.5) - (oppForm.atsForm ?? 0.5)) * 28 +
        (pickForm.upsetProxy - oppForm.upsetProxy) * 0.35 +
        netRatingBonus(pickForm, oppForm) +
        sosBonus(pickForm, oppForm) +
        toMarginBonus(pickForm, oppForm);

      const spread = pick.spread ?? null;

      // Use proprietary NBA efficiency model when home/away context is available
      let modelSpread: number | null = null;
      if (pick.league === "NBA" && nbaEfficiency && pick.homeAway) {
        const isPickHome = pick.homeAway === "home";
        const homeTeam = isPickHome ? pick.team : pick.opponent;
        const awayTeam = isPickHome ? pick.opponent : pick.team;
        modelSpread = buildNbaEfficiencySpread(homeTeam, awayTeam, nbaEfficiency, isPickHome);
      }
      if (modelSpread == null) {
        modelSpread = regressionSpread(spread);
      }

      // ── Contextual adjustments ──────────────────────────────────────────
      const gameMs = primary.gameDate.getTime();

      // 1. Home/away advantage
      const league = pick.league;
      const homeAdv = HOME_ADVANTAGE_PTS[league] ?? 2.5;
      const isPickHome = pick.homeAway === "home";
      const homeAdjustment = isPickHome ? homeAdv : pick.homeAway === "away" ? -homeAdv : 0;

      // 2. Rest/fatigue
      const pickRestDays = daysOfRest(pickHistory, gameMs);
      const oppRestDays = daysOfRest(oppHistory, gameMs);
      const restAdjustment = restEdgeBonus(pickRestDays) - restEdgeBonus(oppRestDays);

      // 3. Injury impact (NBA/NFL only — those are the leagues we have injury data for)
      const leagueInjuries = injuries?.[league.toLowerCase()] ?? [];
      const pickInjPenalty = injuryEdgePenalty(pick.team, leagueInjuries, league);
      const oppInjPenalty = injuryEdgePenalty(pick.opponent, leagueInjuries, league);
      const injuryAdjustment = oppInjPenalty - pickInjPenalty;

      // 4. Large-favorite penalty (spread regression)
      const largeFavPenalty = spread != null && spread < -10 ? (Math.abs(spread) - 10) * 1.0 : 0;

      const score = Math.round(clamp(rawScore + homeAdjustment + restAdjustment + injuryAdjustment - largeFavPenalty, 1, 99));
      const confidence = Number((clamp(0.45 + Math.abs(score - 50) / 70, 0.35, 0.95) * 100).toFixed(0));
      // ────────────────────────────────────────────────────────────────────

      const rationaleSignals = [
        `Momentum edge ${momentumEdge >= 0 ? "+" : ""}${momentumEdge.toFixed(2)} (last-10 trend)`,
        atsEdge == null ? "ATS edge unavailable (insufficient ATS history)" : `ATS edge ${atsEdge >= 0 ? "+" : ""}${atsEdge.toFixed(2)}`,
        `Model edge ${(pickForm.upsetProxy - oppForm.upsetProxy) >= 0 ? "+" : ""}${(pickForm.upsetProxy - oppForm.upsetProxy).toFixed(1)} (context signal)`,
      ];

      // Home/away signal
      if (pick.homeAway) {
        rationaleSignals.push(`${isPickHome ? "Home" : "Away"} (${isPickHome ? "+" : "-"}${homeAdv.toFixed(1)} pt adjustment)`);
      }
      // Rest signal
      if (pickRestDays != null || oppRestDays != null) {
        const pickLabel = pickRestDays == null ? "?" : pickRestDays <= 1 ? "B2B" : `${pickRestDays}d rest`;
        const oppLabel = oppRestDays == null ? "?" : oppRestDays <= 1 ? "B2B" : `${oppRestDays}d rest`;
        rationaleSignals.push(`Rest: ${pick.team} ${pickLabel} vs ${pick.opponent} ${oppLabel}`);
      }
      // Injury signals
      if (pickInjPenalty > 0) rationaleSignals.push(`Injury penalty: ${pick.team} -${pickInjPenalty.toFixed(1)} pts`);
      if (oppInjPenalty > 0) rationaleSignals.push(`Injury boost: ${pick.opponent} -${oppInjPenalty.toFixed(1)} pts (opponent)`);

      // Spread regression signal
      if (spread != null && modelSpread != null && Math.abs(spread - modelSpread) >= 3) {
        rationaleSignals.push(`Market line ${spread > 0 ? "+" : ""}${spread}, model estimate ${modelSpread > 0 ? "+" : ""}${modelSpread} (regression to mean)`);
      }

      // Advanced metric signals
      if (pickForm.netRating != null && oppForm.netRating != null) {
        const diff = pickForm.netRating - oppForm.netRating;
        rationaleSignals.push(`Net Rating edge: ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}`);
      }
      if (pickForm.sos != null && oppForm.sos != null) {
        rationaleSignals.push(`SOS: ${pickForm.sos.toFixed(3)} vs ${oppForm.sos.toFixed(3)}`);
      }
      if (pickForm.turnoverMargin != null && oppForm.turnoverMargin != null) {
        const diff = pickForm.turnoverMargin - oppForm.turnoverMargin;
        rationaleSignals.push(`TO Margin edge: ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}`);
      }

      const line = spread == null ? null : `${pick.team} ${spread > 0 ? "+" : ""}${spread}`;

      return {
        league: pick.league,
        conference: pick.conference ?? null,
        gameDate: pick.gameDate,
        matchup: `${pick.team} vs ${pick.opponent}`,
        pickTeam: pick.team,
        opponent: pick.opponent,
        spread,
        modelSpread,
        line,
        score,
        confidence,
        rationaleSignals,
        momentumEdge,
        atsEdge,
      };
    })
    .filter((game): game is BestBetGame => Boolean(game))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function spreadForTeamFromOdds(event: OddsEventLike, team: string) {
  const points = (event.bookmakers ?? [])
    .flatMap((b) => b.markets ?? [])
    .filter((m) => m.key === "spreads")
    .flatMap((m) => m.outcomes ?? [])
    .filter((o) => o.name === team)
    .map((o) => o.point)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));

  if (!points.length) return null;
  return Number((points.reduce((sum, p) => sum + p, 0) / points.length).toFixed(1));
}

function normalizeTeamName(value: string) {
  return value
    .toLowerCase()
    .replace(/\buniversity\b/g, "")
    .replace(/\bstate\b/g, "st")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveHistoryForOddsTeam(oddsTeam: string, historyByTeam: Record<string, FreeStatLike[]>) {
  const entries = Object.entries(historyByTeam);
  const normalizedOdds = normalizeTeamName(oddsTeam);
  const oddsTokens = new Set(normalizedOdds.split(" ").filter(Boolean));

  // 1. Exact match
  const exact = entries.find(([team]) => normalizeTeamName(team) === normalizedOdds);
  if (exact) return exact;

  // 2. Jaccard token similarity — avoids false containment matches like
  //    "Alabama" ⊂ "North Alabama Lions" or "Duke" ⊂ "Duquesne Dukes".
  //    Tokens are whole words only (no substring checks).
  const scored = entries
    .map(([team, rows]) => {
      const teamTokens = new Set(normalizeTeamName(team).split(" ").filter(Boolean));
      const intersection = [...oddsTokens].filter((tok) => teamTokens.has(tok)).length;
      if (intersection === 0) return null;
      const union = new Set([...oddsTokens, ...teamTokens]).size;
      const jaccard = intersection / union;
      return { team, rows, intersection, jaccard };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => {
      if (Math.abs(b.jaccard - a.jaccard) > 0.01) return b.jaccard - a.jaccard;
      return b.intersection - a.intersection;
    });

  const best = scored[0];
  if (!best) return [oddsTeam, []] as const;
  return [best.team, best.rows] as const;
}

function buildLeagueOddsBestBets(league: string, sportKey: string, standingsKey: string, completedRows: FreeStatLike[], oddsEvents: OddsEventLike[], standings?: Record<string, StandingsEntry[]>, injuries?: InjuryEntry[], nbaEfficiency?: NbaEfficiencyData) {
  const leagueCompleted = completedRows.filter((r) => r.league === league);
  if (!leagueCompleted.length || !oddsEvents.length) return [] as BestBetGame[];

  const todayEt = dayKeyInEt(new Date());
  const leagueStandings = standings?.[standingsKey] ?? [];
  const historyByTeam = leagueCompleted.reduce<Record<string, FreeStatLike[]>>((acc, row) => {
    if (!acc[row.team]) acc[row.team] = [];
    acc[row.team].push(row);
    return acc;
  }, {});

  Object.values(historyByTeam).forEach((rows) => rows.sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime()));

  const gamesToday = oddsEvents.filter((event) => {
    if (!event.home_team || !event.away_team || !event.commence_time) return false;
    if (event.sport_key && event.sport_key !== sportKey) return false;
    return dayKeyInEt(new Date(event.commence_time)) === todayEt;
  });

  return gamesToday
    .map((event) => {
      const home = event.home_team!;
      const away = event.away_team!;

      const [resolvedHome, homeHistory] = resolveHistoryForOddsTeam(home, historyByTeam);
      const [resolvedAway, awayHistory] = resolveHistoryForOddsTeam(away, historyByTeam);

      const homeForm = computeTeamForm(league, homeHistory.slice(0, 10), leagueStandings);
      const awayForm = computeTeamForm(league, awayHistory.slice(0, 10), leagueStandings);

      const netRatingBonus = (form: TeamForm, oppF: TeamForm) => {
        if (form.netRating != null && oppF.netRating != null) return (form.netRating - oppF.netRating) * 0.5;
        return 0;
      };
      const sosBonus = (form: TeamForm, oppF: TeamForm) => {
        if (form.sos != null && oppF.sos != null) return (form.sos - oppF.sos) * 15;
        return 0;
      };

      // Resolve scraped ATS before edge calculation so it feeds into team selection
      const homeScrapedAts = resolveScrapedAtsCoverPct(home, true,  scrapedAts);
      const awayScrapedAts = resolveScrapedAtsCoverPct(away, false, scrapedAts);
      const homeBlendedAtsForm = blendAtsCoverPct(homeForm.atsForm, homeScrapedAts);
      const awayBlendedAtsForm = blendAtsCoverPct(awayForm.atsForm, awayScrapedAts);

      const homeEdge =
        homeForm.momentum * 22 + ((homeBlendedAtsForm ?? 0.5) - 0.5) * 26 + (homeForm.upsetProxy - awayForm.upsetProxy) * 0.3
        + netRatingBonus(homeForm, awayForm) + sosBonus(homeForm, awayForm);
      const awayEdge =
        awayForm.momentum * 22 + ((awayBlendedAtsForm ?? 0.5) - 0.5) * 26 + (awayForm.upsetProxy - homeForm.upsetProxy) * 0.3
        + netRatingBonus(awayForm, homeForm) + sosBonus(awayForm, homeForm);

      const pickHome = homeEdge >= awayEdge;
      const pickTeam = pickHome ? home : away;
      const opponent = pickHome ? away : home;
      const pickForm = pickHome ? homeForm : awayForm;
      const oppForm = pickHome ? awayForm : homeForm;

      const momentumEdge = Number((pickForm.momentum - oppForm.momentum).toFixed(2));

      // Blend DB recent ATS form with full-season scraped ATS (70/30 weighting)
      const pickScrapedAts = resolveScrapedAtsCoverPct(pickTeam, pickHome, scrapedAts);
      const oppScrapedAts  = resolveScrapedAtsCoverPct(opponent,  !pickHome, scrapedAts);
      const pickBlendedAts = blendAtsCoverPct(pickForm.atsForm, pickScrapedAts);
      const oppBlendedAts  = blendAtsCoverPct(oppForm.atsForm,  oppScrapedAts);
      const atsEdge =
        pickBlendedAts == null || oppBlendedAts == null
          ? null
          : Number((pickBlendedAts - oppBlendedAts).toFixed(3));

      // Match consensus game from covers.com
      const consensusGame = consensusGames
        ? matchConsensusGame(home, away, consensusGames)
        : null;

      const modelEdge = pickHome ? homeEdge : awayEdge;
      const spread = spreadForTeamFromOdds(event, pickTeam);

      // Use proprietary NBA efficiency model when data is available — otherwise fall back to regression
      let modelSpread: number | null = null;
      if (league === "NBA" && nbaEfficiency) {
        modelSpread = buildNbaEfficiencySpread(home, away, nbaEfficiency, pickHome);
      }
      if (modelSpread == null) {
        modelSpread = regressionSpread(spread);
      }

      // ── Contextual adjustments ──────────────────────────────────────────
      const gameMs = new Date(event.commence_time!).getTime();

      // 1. Home court advantage
      const homeAdv = HOME_ADVANTAGE_PTS[league] ?? 2.5;
      const homeAdjustment = pickHome ? homeAdv : -homeAdv;

      // 2. Rest/fatigue
      const pickHistory = [...(pickHome ? homeHistory : awayHistory)];
      const oppHistory = [...(pickHome ? awayHistory : homeHistory)];
      const pickRestDays = daysOfRest(pickHistory, gameMs);
      const oppRestDays = daysOfRest(oppHistory, gameMs);
      const restAdjustment = restEdgeBonus(pickRestDays) - restEdgeBonus(oppRestDays);

      // 3. Injury impact
      const leagueInjuries = injuries ?? [];
      const pickInjPenalty = injuryEdgePenalty(pickTeam, leagueInjuries, league);
      const oppInjPenalty = injuryEdgePenalty(opponent, leagueInjuries, league);
      const injuryAdjustment = oppInjPenalty - pickInjPenalty;

      // 4. Bookmaker consensus (line movement proxy)
      const consensus = bookmakerConsensus(event, pickTeam);
      const consensusPenalty = consensus.variance > 1.0 ? 2 : 0; // high variance = less certainty

      // 5. Large-favorite penalty
      const largeFavPenalty = spread != null && spread < -10 ? (Math.abs(spread) - 10) * 1.0 : 0;

      const rawScore = 52 + modelEdge * 0.32;
      const score = Math.round(clamp(rawScore + homeAdjustment + restAdjustment + injuryAdjustment - largeFavPenalty - consensusPenalty, 1, 99));
      const confidence = Number((clamp(0.45 + Math.abs(score - 50) / 95, 0.35, 0.9) * 100).toFixed(0));
      // ────────────────────────────────────────────────────────────────────

      const line = spread == null ? null : `${pickTeam} ${spread > 0 ? "+" : ""}${spread}`;

      const pickHistoryCount = pickHistory.length;
      const oppHistoryCount = oppHistory.length;

      // ATS signal label: note when scraped data is augmenting the DB sample
      const atsSignalLabel = (() => {
        if (atsEdge == null) return "ATS edge unavailable (limited ATS sample)";
        const edge = `${atsEdge >= 0 ? "+" : ""}${atsEdge.toFixed(3)}`;
        if (pickScrapedAts !== null && oppScrapedAts !== null) return `ATS edge ${edge} (season blended)`;
        if (pickScrapedAts !== null || oppScrapedAts !== null) return `ATS edge ${edge} (partial scraped)`;
        return `ATS edge ${edge}`;
      })();

      const rationaleSignals = [
        `Momentum edge ${momentumEdge >= 0 ? "+" : ""}${momentumEdge.toFixed(2)} (last-10 trend proxy)`,
        atsSignalLabel,
        `History sample ${pickTeam}: ${pickHistoryCount} games (mapped ${pickTeam === home ? resolvedHome : resolvedAway}) vs ${opponent}: ${oppHistoryCount} games`,
      ];

      // Home court signal
      rationaleSignals.push(`${pickHome ? "Home court" : "Away"} (+${pickHome ? homeAdv : -homeAdv} pt adjustment)`);

      // Rest signal
      if (pickRestDays != null || oppRestDays != null) {
        const pickLabel = pickRestDays == null ? "?" : pickRestDays <= 1 ? "B2B" : `${pickRestDays}d rest`;
        const oppLabel = oppRestDays == null ? "?" : oppRestDays <= 1 ? "B2B" : `${oppRestDays}d rest`;
        rationaleSignals.push(`Rest: ${pickTeam} ${pickLabel} vs ${opponent} ${oppLabel}`);
      }

      // Bookmaker consensus signal
      if (consensus.bookCount > 1) {
        const certainty = consensus.variance <= 0.25 ? "tight consensus" : consensus.variance > 1.0 ? "high disagreement" : "moderate consensus";
        rationaleSignals.push(`${consensus.bookCount} books: avg ${consensus.avg ?? spread}, variance ${consensus.variance} (${certainty})`);
      }

      // Spread regression signal
      if (spread != null && modelSpread != null && Math.abs(spread - modelSpread) >= 3) {
        rationaleSignals.push(`Market line ${spread > 0 ? "+" : ""}${spread}, model estimate ${modelSpread > 0 ? "+" : ""}${modelSpread} (regression to mean)`);
      }

      if (pickForm.netRating != null && oppForm.netRating != null) {
        const diff = pickForm.netRating - oppForm.netRating;
        rationaleSignals.push(`Net Rating edge: ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}`);
      }
      if (pickForm.sos != null && oppForm.sos != null) {
        rationaleSignals.push(`SOS: ${pickForm.sos.toFixed(3)} vs ${oppForm.sos.toFixed(3)}`);
      }

      // Scraped season ATS record signal
      if (pickScrapedAts !== null) {
        const pct = Math.round(pickScrapedAts * 100);
        rationaleSignals.push(`Season ATS: ${pickTeam} ${pct}% cover rate (full season)`);
      }

      // Public consensus / sharp money signal
      if (consensusGame) {
        const sp = consensusGame.spread;
        const pickIsHome = pickHome;
        const publicOnPick = pickIsHome ? sp.homePct : sp.awayPct;
        const publicOnOpp  = pickIsHome ? sp.awayPct : sp.homePct;
        if (publicOnPick != null && publicOnOpp != null) {
          const sharpNote = sp.sharpSide
            ? sp.sharpSide === (pickIsHome ? "home" : "away")
              ? " — sharp money agrees"
              : " — SHARP FADE (public fade pick)"
            : "";
          rationaleSignals.push(
            `Public consensus: ${publicOnPick}% on ${pickTeam} / ${publicOnOpp}% on ${opponent}${sharpNote}`,
          );
        }
      }

      return {
        league,
        conference: null,
        gameDate: new Date(event.commence_time!),
        matchup: `${away} at ${home}`,
        pickTeam,
        opponent,
        spread,
        modelSpread,
        line,
        score,
        confidence,
        rationaleSignals,
        momentumEdge,
        atsEdge,
      } as BestBetGame;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
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
              const score =
                50 +
                (metrics.last10Momentum ?? 0) * momentumWeight +
                ((metrics.atsForm ?? 0.5) - 0.5) * atsWeight +
                (metrics.upsetAlertScore - 50) * upsetWeight;
              if (score < threshold) continue;

              picks += 1;
              if (game.atsResult === "W") wins += 1;
              else losses += 1;
            }
          });

          if (picks < 20) continue;
          const hitRate = wins / Math.max(1, wins + losses);
          const objective = hitRate - Math.max(0, 40 - picks) * 0.001;
          if (objective > best.score)
            best = { momentumWeight, atsWeight, upsetWeight: Number(upsetWeight.toFixed(2)), threshold, score: objective };
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

// ---------------------------------------------------------------------------
// NBA efficiency model types and helpers
// ---------------------------------------------------------------------------

export type NbaTeamEfficiency = {
  netRtg: number | null;
  offRtg: number | null;
  defRtg: number | null;
  pace: number | null;
  homeNetRtg: number | null;
  awayNetRtg: number | null;
};

export type NbaEfficiencyData = {
  fetchedAt?: string;
  season?: string;
  teams: Record<string, NbaTeamEfficiency>;
};

function normalizeTeamKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function findTeamEfficiency(teamName: string, data: NbaEfficiencyData): NbaTeamEfficiency | null {
  // Exact match
  if (data.teams[teamName]) return data.teams[teamName];

  const normTarget = normalizeTeamKey(teamName);
  const targetWords = normTarget.split(/\s+/);
  const lastWord = targetWords[targetWords.length - 1];

  let bestMatch: NbaTeamEfficiency | null = null;

  for (const [key, val] of Object.entries(data.teams)) {
    const normKey = normalizeTeamKey(key);
    if (normKey === normTarget) return val;              // normalized exact
    if (normKey.includes(normTarget) || normTarget.includes(normKey)) {
      bestMatch = val;
      continue;
    }
    // Last-word (nickname) match — e.g. "Thunder" in "Oklahoma City Thunder"
    const keyWords = normKey.split(/\s+/);
    if (keyWords[keyWords.length - 1] === lastWord) {
      bestMatch = val;
    }
  }

  return bestMatch;
}

/**
 * Build a model spread using NBA efficiency ratings (independent of bookmakers).
 *
 * predictedHomeMargin = (homeNetRtg - awayNetRtg) * 0.45 + 1.5
 *   0.45 = pts per NetRtg point (empirical)
 *   1.5  = residual home court not captured by split ratings
 *
 * Returns spread from the pick team's perspective:
 *   negative = pick team favored, positive = pick team underdog
 */
function buildNbaEfficiencySpread(
  homeTeam: string,
  awayTeam: string,
  data: NbaEfficiencyData,
  isPickHome: boolean,
): number | null {
  const homeEff = findTeamEfficiency(homeTeam, data);
  const awayEff = findTeamEfficiency(awayTeam, data);
  if (!homeEff || !awayEff) return null;

  const homeNetRtg = homeEff.homeNetRtg ?? homeEff.netRtg;
  const awayNetRtg = awayEff.awayNetRtg ?? awayEff.netRtg;
  if (homeNetRtg == null || awayNetRtg == null) return null;

  const predictedHomeMargin = (homeNetRtg - awayNetRtg) * 0.45 + 1.5;
  const spread = isPickHome ? -predictedHomeMargin : predictedHomeMargin;
  return Math.round(spread * 10) / 10;
}

export type BuildOptions = {
  oddsEvents?: OddsEventLike[];
  standings?: Record<string, StandingsEntry[]>;
  injuries?: Record<string, InjuryEntry[]>;
  nbaEfficiency?: NbaEfficiencyData;
};

export function buildFreeStatsSummary(rows: FreeStatLike[], options?: BuildOptions) {
  const sorted = [...rows].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());
  const nowMs = Date.now();
  const completed = sorted.filter((row) => isCompletedGame(row, nowMs));
  const byLeague = groupByLeague(completed);
  const standingsMap = options?.standings ?? {};

  const leagues = Object.entries(byLeague)
    .map(([league, leagueRows]) => {
      const recent = leagueRows.slice(0, 10);
      const trend = trendScore(league, leagueRows.length, recent);
      const conferences = [...new Set(leagueRows.map((r) => r.conference).filter(Boolean))] as string[];
      const ncaab = league === "NCAAB" ? computeNcaabMetrics(recent) : null;

      // Compute advanced metrics per team
      const byTeamMap = groupByTeam(leagueRows);
      const leagueStandings = standingsMap[league.toLowerCase()] ?? [];
      let advanced: BasketballAdvanced | FootballAdvanced | BaseballAdvanced | null = null;
      const teamAdvanced: Record<string, BasketballAdvanced | FootballAdvanced | BaseballAdvanced> = {};

      const allBoxRows = leagueRows.map(toBoxScoreRow);

      if (league === "NBA" || league === "NCAAB") {
        advanced = computeBasketballAdvanced(allBoxRows, leagueStandings);
        for (const [team, teamRows] of Object.entries(byTeamMap)) {
          teamAdvanced[team] = computeBasketballAdvanced(teamRows.map(toBoxScoreRow), leagueStandings);
        }
      } else if (league === "NFL") {
        advanced = computeFootballAdvanced(allBoxRows, leagueStandings);
        for (const [team, teamRows] of Object.entries(byTeamMap)) {
          teamAdvanced[team] = computeFootballAdvanced(teamRows.map(toBoxScoreRow), leagueStandings);
        }
      } else if (league === "MLB") {
        advanced = computeBaseballAdvanced(allBoxRows, leagueStandings);
        for (const [team, teamRows] of Object.entries(byTeamMap)) {
          teamAdvanced[team] = computeBaseballAdvanced(teamRows.map(toBoxScoreRow), leagueStandings);
        }
      }

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
        advanced,
        teamAdvanced,
      };
    })
    .sort((a, b) => a.league.localeCompare(b.league));

  const latestByLeague = Object.values(byLeague)
    .map((leagueRows) => {
      const latest = leagueRows[0];
      return {
        ...latest,
        gameStatus: latest.gameStatus ?? "UNKNOWN",
        completionEvidence: inferCompletionEvidence(latest),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());

  const ncaabRows = completed.filter((r) => r.league === "NCAAB");
  const params = calibrateBestBetModel(ncaabRows);
  const injuriesMap = options?.injuries as Record<string, InjuryEntry[]> | undefined;
  const oddsEvents = options?.oddsEvents ?? [];
  const nbaEfficiency = options?.nbaEfficiency;
  const ncaabBets = buildLeagueOddsBestBets("NCAAB", "basketball_ncaab", "ncaab", completed, oddsEvents, standingsMap, injuriesMap?.ncaab);
  const nbaBets = buildLeagueOddsBestBets("NBA", "basketball_nba", "nba", completed, oddsEvents, standingsMap, injuriesMap?.nba, nbaEfficiency);
  const oddsBasedBets = [...ncaabBets, ...nbaBets].sort((a, b) => b.score - a.score);
  const bestBets = oddsBasedBets.length ? oddsBasedBets : buildGameLevelBestBets(sorted, completed, standingsMap, injuriesMap, nbaEfficiency);
  const topTarget = 5;
  const todayEt = dayKeyInEt(new Date());
  const bestBetsNote =
    bestBets.length >= topTarget
      ? null
      : `Only ${bestBets.length} eligible game${bestBets.length === 1 ? "" : "s"} found on ${todayEt} (America/New_York). Top 5 is not backfilled from other dates.`;

  return {
    generatedAt: new Date().toISOString(),
    ready: leagues.length > 0,
    recordsIngested: sorted.length,
    recordsCompleted: completed.length,
    recordsRejected: sorted.length - completed.length,
    leagues,
    latestByLeague,
    conferences: [...new Set(completed.map((r) => r.conference).filter(Boolean))].sort(),
    bestBets,
    topBestBetsTarget: topTarget,
    topBestBetsDateEt: todayEt,
    topBestBetsFallbackUsed: false,
    bestBetsNote,
    bestBetModel: params,
    injuries: options?.injuries ?? {},
  };
}
