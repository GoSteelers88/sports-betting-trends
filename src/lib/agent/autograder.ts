// Daily auto-grader. Fetches yesterday's final scores from ESPN's public
// scoreboard endpoints and writes AgentOutcome rows for any pending picks
// that match. Without this the dream agent has no data to learn from.
//
// Handles two pick shapes:
//   • moneyline — picks resolved via team-level final score lookup.
//   • prop      — picks resolved via player box-score line (shared logic
//                 lives in src/lib/prop-grading.ts, also used by the
//                 snapshot grader and the prop projector).

import { prisma } from "@/lib/prisma";
import {
  buildPlayerStatLookup,
  resolveProp,
  type PlayerStatLookup,
  type PropGradingLeague,
} from "@/lib/prop-grading";

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

const ESPN: Record<"NBA" | "MLB" | "WNBA" | "NHL" | "NCAAB", string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  WNBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard",
  NHL: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard",
  NCAAB: "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard",
};

type GameFinal = {
  league: "NBA" | "MLB" | "WNBA" | "NHL" | "NCAAB";
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  date: string;
};

async function fetchFinalsForDay(league: "NBA" | "MLB" | "WNBA" | "NHL" | "NCAAB", yyyymmdd: string): Promise<GameFinal[]> {
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
export function teamMatches(needle: string, haystack: string): boolean {
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

// True iff this ESPN final belongs to the same game as the pick.
// Requires BOTH ESPN teams to appear in pick.matchup — not just one — so
// "Texas Rangers vs Arizona Diamondbacks" cannot match a "Mets @ D'backs"
// final. Also requires the selection to be one of the two ESPN teams so
// we can grade win/loss correctly. The 36-hour proximity gate is layered
// on top of this in the caller.
export function matchesPickToFinal(
  pick: { matchup: string; selection: string },
  final: { homeTeam: string; awayTeam: string }
): boolean {
  const bothTeamsInMatchup =
    teamMatches(final.homeTeam, pick.matchup) &&
    teamMatches(final.awayTeam, pick.matchup);
  if (!bothTeamsInMatchup) return false;
  const selectionMatchesEspnTeam =
    teamMatches(final.homeTeam, pick.selection) ||
    teamMatches(final.awayTeam, pick.selection);
  return selectionMatchesEspnTeam;
}

type GradeResult = "win" | "loss" | "push" | "void";

export function gradeMoneyline(selection: string, finals: GameFinal): GradeResult | null {
  const home = finals.homeTeam;
  const away = finals.awayTeam;
  const pickedHome = teamMatches(home, selection);
  const pickedAway = teamMatches(away, selection);
  if (!pickedHome && !pickedAway) return null;
  // Ambiguous: the selection matched BOTH teams (e.g. "Sox" matches both
  // White Sox and Red Sox once the <4-char token filter drops "sox"). Refuse
  // to grade rather than silently default to the home arm — a wrong grade
  // corrupts the trial ledger worse than an ungraded pick does.
  if (pickedHome && pickedAway) return null;
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
  // from the last 3 days, since cron may have missed runs). Grades both
  // moneyline AND prop picks; spread/total still skipped until line lookup wired.
  const since = new Date(target);
  since.setUTCDate(since.getUTCDate() - 2);
  const pendingPicks = await prisma.agentPick.findMany({
    where: {
      gameDate: { gte: since },
      outcome: null,
      market: { in: ["moneyline", "prop"] },
    },
  });

  // Query ±1 day to cover the ET/UTC boundary slip on late-night games.
  const dates: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const d = new Date(target);
    d.setUTCDate(d.getUTCDate() + offset);
    dates.push(yyyymmddUtc(d));
  }

  const mlPicks = pendingPicks.filter(p => p.market === "moneyline");
  const propPicks = pendingPicks.filter(p => p.market === "prop");

  const leagues = Array.from(new Set(mlPicks.map(p => p.league))) as Array<"NBA" | "MLB" | "WNBA" | "NHL" | "NCAAB">;
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

  // Box-score lookups for prop picks. NBA, MLB + WNBA have the player-stat
  // extractor (WNBA shares the basketball box-score schema); props from any
  // other league fall through to unmatched.
  const propLeagues = Array.from(
    new Set(
      propPicks
        .map(p => p.league)
        .filter((l): l is PropGradingLeague => l === "NBA" || l === "MLB" || l === "WNBA")
    )
  );
  const lookupByLeague = new Map<PropGradingLeague, PlayerStatLookup>();
  for (const lg of propLeagues) {
    lookupByLeague.set(lg, await buildPlayerStatLookup(lg, yyyymmddDate));
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

  // ─── moneyline branch ─────────────────────────────────────────────────────
  for (const pick of mlPicks) {
    const finals = finalsByLeague.get(pick.league) ?? [];
    const pickTime = pick.gameDate.getTime();
    const match = finals.find(f => {
      if (!matchesPickToFinal(pick, f)) return false;
      if (!f.date) return true;
      const ft = new Date(f.date).getTime();
      if (!Number.isFinite(ft)) return true;
      return Math.abs(ft - pickTime) < PROXIMITY_MS;
    });
    if (!match) {
      report.unmatched++;
      continue;
    }

    const result = gradeMoneyline(pick.selection, match);
    if (!result) {
      report.unmatched++;
      continue;
    }

    const pnl = unitsPnl(pick.oddsAmerican, pick.kellyStakeUnits, result);
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

    tallyResult(report, pick.league, result, pnl);
  }

  // ─── prop branch ──────────────────────────────────────────────────────────
  for (const pick of propPicks) {
    if (pick.league !== "NBA" && pick.league !== "MLB" && pick.league !== "WNBA") {
      report.unmatched++;
      continue;
    }
    if (!pick.player || !pick.propType || pick.line === null || (pick.side !== "over" && pick.side !== "under")) {
      // Missing structured fields → can't auto-resolve. These will need
      // manual grading via /grade. Counted as unmatched for visibility.
      report.unmatched++;
      continue;
    }
    const lookup = lookupByLeague.get(pick.league);
    if (!lookup) {
      report.unmatched++;
      continue;
    }
    const resolved = resolveProp(lookup, {
      player: pick.player,
      propType: pick.propType,
      line: pick.line,
      side: pick.side,
      anchorMs: pick.gameDate.getTime(),
    });
    if (!resolved) {
      report.unmatched++;
      continue;
    }
    const pnl = unitsPnl(pick.oddsAmerican, pick.kellyStakeUnits, resolved.result);
    const actualOutcome = `${pick.player}: ${resolved.actual} (line ${pick.line} ${pick.side})`;
    try {
      await prisma.agentOutcome.upsert({
        where: { pickId: pick.id },
        create: {
          pickId: pick.id,
          result: resolved.result,
          actualOutcome,
          unitsPnl: pnl,
          notes: "auto-graded prop from ESPN box score",
        },
        update: {
          result: resolved.result,
          actualOutcome,
          unitsPnl: pnl,
          notes: "auto-graded prop from ESPN box score (regraded)",
          gradedAt: new Date(),
        },
      });
    } catch (err) {
      console.error(`failed to grade prop pick #${pick.id}:`, err);
      report.unmatched++;
      continue;
    }
    tallyResult(report, pick.league, resolved.result, pnl);
  }

  return report;
}

function tallyResult(
  report: AutoGradeReport,
  league: string,
  result: GradeResult,
  pnl: number
): void {
  report.graded++;
  const lg = (report.byLeague[league] ??= {
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
