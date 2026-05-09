// Daily auto-grader. Fetches yesterday's final scores from ESPN's public
// scoreboard endpoints and writes AgentOutcome rows for any pending picks
// that match. Without this the dream agent has no data to learn from.

import { prisma } from "@/lib/prisma";

type Espn = {
  events?: Array<{
    id: string;
    name?: string;
    shortName?: string;
    date?: string;
    status?: { type?: { completed?: boolean; description?: string } };
    competitions?: Array<{
      competitors?: Array<{
        homeAway?: "home" | "away";
        score?: string;
        team?: { displayName?: string; shortDisplayName?: string };
        winner?: boolean;
      }>;
    }>;
  }>;
};

const ESPN: Record<"NBA" | "MLB" | "WNBA" | "NCAAB", string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  WNBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard",
  NCAAB: "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard",
};

type GameFinal = {
  league: "NBA" | "MLB" | "WNBA" | "NCAAB";
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  date: string;
};

async function fetchFinalsForDay(league: "NBA" | "MLB" | "WNBA" | "NCAAB", yyyymmdd: string): Promise<GameFinal[]> {
  const url = `${ESPN[league]}?dates=${yyyymmdd}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "sports-betting-trends-agent/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Espn;
  const out: GameFinal[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.status?.type?.completed) continue;
    const competitors = ev.competitions?.[0]?.competitors ?? [];
    const home = competitors.find(c => c.homeAway === "home");
    const away = competitors.find(c => c.homeAway === "away");
    if (!home?.team?.displayName || !away?.team?.displayName) continue;
    const hs = parseInt(home.score ?? "", 10);
    const as = parseInt(away.score ?? "", 10);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;
    out.push({
      league,
      homeTeam: home.team.displayName,
      awayTeam: away.team.displayName,
      homeScore: hs,
      awayScore: as,
      date: ev.date ?? "",
    });
  }
  return out;
}

// Token-aware matcher: avoids "New York" matching both Yankees and Mets.
function teamMatches(needle: string, haystack: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[.'-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const a = norm(needle);
  const b = norm(haystack);
  if (!a || !b) return false;
  if (a === b) return true;
  const tokensA = a.split(/\s+/).filter(t => t.length >= 4);
  const tokensB = b.split(/\s+/).filter(t => t.length >= 4);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return a.includes(b) || b.includes(a);
  }
  const [need, have] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const haveSet = new Set(have);
  return need.every(t => haveSet.has(t));
}

type GradeResult = "win" | "loss" | "push" | "void";

function gradeMoneyline(selection: string, finals: GameFinal): GradeResult | null {
  const home = finals.homeTeam;
  const away = finals.awayTeam;
  const pickedHome = teamMatches(home, selection);
  const pickedAway = teamMatches(away, selection);
  if (!pickedHome && !pickedAway) return null;
  // NBA/MLB don't allow ties; a tied "final" is bad data → mark void, not push.
  if (finals.homeScore === finals.awayScore) return "void";
  const homeWon = finals.homeScore > finals.awayScore;
  if (pickedHome) return homeWon ? "win" : "loss";
  return homeWon ? "loss" : "win";
}

function unitsPnl(american: number, stake: number, result: GradeResult): number {
  if (result === "win") {
    const decimal = american > 0 ? american / 100 : 100 / -american;
    return +(stake * decimal).toFixed(4);
  }
  if (result === "loss") return -stake;
  return 0;
}

export type AutoGradeReport = {
  ranAt: string;
  date: string;
  picksChecked: number;
  graded: number;
  unmatched: number;
  byLeague: Record<string, { graded: number; wins: number; losses: number; pushes: number; unitsPnl: number }>;
};

function yyyymmddUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export async function autoGradeYesterday(daysBack = 1): Promise<AutoGradeReport> {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() - daysBack);
  const yyyymmddDate = yyyymmddUtc(target);

  // Pull pending picks from the target date (loose window — anything with no outcome
  // from the last 3 days, since cron may have missed runs)
  const since = new Date(target);
  since.setUTCDate(since.getUTCDate() - 2);
  const pendingPicks = await prisma.agentPick.findMany({
    where: {
      gameDate: { gte: since },
      outcome: null,
      market: "moneyline", // v1: moneyline only — spread/total need line lookup
    },
  });

  // Query ±1 day to cover the ET/UTC boundary slip on late-night games.
  const dates: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const d = new Date(target);
    d.setUTCDate(d.getUTCDate() + offset);
    dates.push(yyyymmddUtc(d));
  }

  const leagues = Array.from(new Set(pendingPicks.map(p => p.league))) as Array<"NBA" | "MLB" | "WNBA" | "NCAAB">;
  const finalsByLeague = new Map<string, GameFinal[]>();
  for (const lg of leagues) {
    const seenIds = new Set<string>();
    const all: GameFinal[] = [];
    for (const d of dates) {
      const finals = await fetchFinalsForDay(lg, d);
      for (const f of finals) {
        const key = `${f.homeTeam}::${f.awayTeam}::${f.date}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        all.push(f);
      }
    }
    finalsByLeague.set(lg, all);
  }

  const report: AutoGradeReport = {
    ranAt: new Date().toISOString(),
    date: yyyymmddDate,
    picksChecked: pendingPicks.length,
    graded: 0,
    unmatched: 0,
    byLeague: {},
  };

  // 36-hour proximity window: a pick from day N can only grade against a game
  // whose ESPN date is within 36h. Stops repeat-matchups (MLB series, NBA b2b)
  // from being mis-graded against the wrong day's score.
  const PROXIMITY_MS = 36 * 60 * 60 * 1000;

  for (const pick of pendingPicks) {
    const finals = finalsByLeague.get(pick.league) ?? [];
    const pickTime = pick.gameDate.getTime();
    // Try to match by both teams in the pick.matchup AND by date proximity
    const match = finals.find(f => {
      const teamOk =
        (teamMatches(f.homeTeam, pick.matchup) || teamMatches(f.awayTeam, pick.matchup)) &&
        (teamMatches(f.homeTeam, pick.selection) || teamMatches(f.awayTeam, pick.selection));
      if (!teamOk) return false;
      if (!f.date) return true; // no date info — fall back to team-only match
      const ft = new Date(f.date).getTime();
      if (!Number.isFinite(ft)) return true;
      return Math.abs(ft - pickTime) < PROXIMITY_MS;
    });
    if (!match) {
      report.unmatched++;
      continue;
    }

    let result: GradeResult | null = null;
    if (pick.market === "moneyline") {
      result = gradeMoneyline(pick.selection, match);
    }
    if (!result) {
      report.unmatched++;
      continue;
    }

    const pnl = unitsPnl(pick.oddsAmerican, pick.kellyStakeUnits, result);
    // Use upsert so concurrent runs (cron + manual trigger) don't crash on
    // unique-pickId constraint.
    try {
      await prisma.agentOutcome.upsert({
        where: { pickId: pick.id },
        create: {
          pickId: pick.id,
          result,
          actualOutcome: `${match.awayTeam} ${match.awayScore} @ ${match.homeTeam} ${match.homeScore}`,
          unitsPnl: pnl,
          notes: "auto-graded from ESPN scoreboard",
        },
        update: {
          result,
          actualOutcome: `${match.awayTeam} ${match.awayScore} @ ${match.homeTeam} ${match.homeScore}`,
          unitsPnl: pnl,
          notes: "auto-graded from ESPN scoreboard (regraded)",
          gradedAt: new Date(),
        },
      });
    } catch (err) {
      console.error(`failed to grade pick #${pick.id}:`, err);
      report.unmatched++;
      continue;
    }

    report.graded++;
    const lg = (report.byLeague[pick.league] ??= {
      graded: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      unitsPnl: 0,
    });
    lg.graded++;
    if (result === "win") lg.wins++;
    else if (result === "loss") lg.losses++;
    else lg.pushes++;
    lg.unitsPnl = +(lg.unitsPnl + pnl).toFixed(4);
  }

  return report;
}
