// Grades ModelPickSnapshot rows by fetching final scores + box scores from
// ESPN's public scoreboard/summary endpoints. Idempotent — only grades rows
// where `result` is null and the game is completed.
//
// The player-prop logic (PROP_STAT_MAP, ESPN parsing, name normalization)
// lives in src/lib/prop-grading.ts so the AgentPick autograder and the
// prop projection engine reuse the same code path.

import { prisma } from "./prisma";
import {
  Espn,
  EspnEvent,
  SCOREBOARD,
  PROP_STAT_MAP,
  PROP_PROXIMITY_MS,
  yyyymmdd,
  normalizeName,
  teamMatches,
  fetchJson,
  buildPlayerStatLookup,
  type PlayerStatLookup,
} from "./prop-grading";

// ─── unit P&L ──────────────────────────────────────────────────────────────

function unitsPnl(american: number | null, stake: number, result: string): number | null {
  if (american === null) return null;
  if (result === "win") {
    const decimal = american > 0 ? american / 100 : 100 / -american;
    return +(stake * decimal).toFixed(4);
  }
  if (result === "loss") return -stake;
  if (result === "push" || result === "void") return 0;
  return null;
}

// ─── prop grading ──────────────────────────────────────────────────────────

async function gradeProps(daysBack: number): Promise<{ graded: number; unmatched: number }> {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() - daysBack);
  const yyyymmddDate = yyyymmdd(target);
  const since = new Date(target);
  since.setUTCDate(since.getUTCDate() - 2);

  // NBA, MLB + WNBA props get graded — different stat lookups per league.
  const pending = await prisma.modelPickSnapshot.findMany({
    where: {
      source: { in: ["prop_nba", "prop_mlb", "prop_wnba"] },
      result: null,
      createdAt: { gte: since },
    },
  });
  if (pending.length === 0) return { graded: 0, unmatched: 0 };

  const emptyLookup: PlayerStatLookup = { byPlayer: new Map() };
  const nbaLookup: PlayerStatLookup = pending.some(p => p.source === "prop_nba")
    ? await buildPlayerStatLookup("NBA", yyyymmddDate)
    : emptyLookup;
  const mlbLookup: PlayerStatLookup = pending.some(p => p.source === "prop_mlb")
    ? await buildPlayerStatLookup("MLB", yyyymmddDate)
    : emptyLookup;
  const wnbaLookup: PlayerStatLookup = pending.some(p => p.source === "prop_wnba")
    ? await buildPlayerStatLookup("WNBA", yyyymmddDate)
    : emptyLookup;
  let graded = 0;
  let unmatched = 0;

  for (const p of pending) {
    if (!p.player || p.line === null || !p.market) {
      unmatched++;
      continue;
    }
    const lookup =
      p.source === "prop_mlb" ? mlbLookup : p.source === "prop_wnba" ? wnbaLookup : nbaLookup;
    const allEntries = lookup.byPlayer.get(normalizeName(p.player));
    if (!allEntries || allEntries.length === 0) {
      unmatched++;
      continue;
    }
    const compute = PROP_STAT_MAP[p.market];
    if (!compute) {
      unmatched++;
      continue;
    }
    const anchor = p.snapshotDate
      ? new Date(`${p.snapshotDate}T12:00:00Z`).getTime()
      : p.createdAt.getTime();
    // Pick the game whose date is closest to the anchor and within 36h
    let best: (typeof allEntries)[number] | null = null;
    let bestDiff = Infinity;
    for (const e of allEntries) {
      const diff = Math.abs(e.eventDate - anchor);
      if (diff < PROP_PROXIMITY_MS && diff < bestDiff) {
        best = e;
        bestDiff = diff;
      }
    }
    if (!best) {
      unmatched++;
      continue;
    }
    const actual = compute(best.stats);
    if (actual === null) {
      unmatched++;
      continue;
    }

    const side = /^over\b/i.test(p.selection.trim()) ? "over" : "under";
    let result: "win" | "loss" | "push";
    if (actual === p.line) result = "push";
    else if (side === "over") result = actual > p.line ? "win" : "loss";
    else result = actual < p.line ? "win" : "loss";

    const stake = 1; // 1 unit per prop snapshot for tracking purposes
    const pnl = unitsPnl(p.oddsAmerican, stake, result);

    await prisma.modelPickSnapshot.update({
      where: { id: p.id },
      data: {
        result,
        actualValue: actual,
        notes: `auto-graded vs ESPN box: ${p.player} ${actual} ${side === "over" ? ">" : "<"} ${p.line}`,
        gradedAt: new Date(),
      },
    });
    void pnl; // P&L stored on AgentOutcome only; ModelPickSnapshot tracks per-pick result
    graded++;
  }
  return { graded, unmatched };
}

// ─── market grading (team-level, like moneylines) ──────────────────────────

async function gradeMarketPicks(daysBack: number): Promise<{ graded: number; unmatched: number }> {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() - daysBack);
  const yyyymmddDate = yyyymmdd(target);
  const since = new Date(target);
  since.setUTCDate(since.getUTCDate() - 2);

  // Grade moneyline, spread, and total market picks. Each uses a different
  // calculation against the same final-score lookup.
  const pending = await prisma.modelPickSnapshot.findMany({
    where: {
      source: "market",
      result: null,
      market: { in: ["moneyline", "spread", "total"] },
      createdAt: { gte: since },
    },
  });
  if (pending.length === 0) return { graded: 0, unmatched: 0 };

  // Determine final scores by league. Query ±1 day to cover ET/UTC boundary slip.
  const base = new Date(
    `${yyyymmddDate.slice(0, 4)}-${yyyymmddDate.slice(4, 6)}-${yyyymmddDate.slice(6, 8)}T00:00:00Z`
  );
  const dates = [-1, 0, 1].map(offset => {
    const d = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    return yyyymmdd(d);
  });
  const byLeague: Record<string, EspnEvent[]> = {};
  for (const lg of new Set(pending.map(p => p.league))) {
    if (lg !== "NBA" && lg !== "MLB" && lg !== "WNBA") continue;
    const seen = new Set<string>();
    const events: EspnEvent[] = [];
    for (const d of dates) {
      const board = await fetchJson<Espn>(`${SCOREBOARD[lg as "NBA" | "MLB" | "WNBA"]}?dates=${d}`);
      for (const ev of board?.events ?? []) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (ev.status?.type?.completed) events.push(ev);
      }
    }
    byLeague[lg] = events;
  }

  let graded = 0;
  let unmatched = 0;

  for (const p of pending) {
    const events = byLeague[p.league] ?? [];
    // Anchor to snapshotDate (logged when the pick was generated) for the
    // proximity check; fall back to createdAt if snapshotDate is missing.
    const anchor = p.snapshotDate
      ? new Date(`${p.snapshotDate}T12:00:00Z`).getTime()
      : p.createdAt.getTime();
    const match = events.find(ev => {
      const competitors = ev.competitions?.[0]?.competitors ?? [];
      const home = competitors.find(c => c.homeAway === "home")?.team?.displayName ?? "";
      const away = competitors.find(c => c.homeAway === "away")?.team?.displayName ?? "";
      const teamOk =
        teamMatches(home, p.selection) ||
        teamMatches(away, p.selection) ||
        (p.matchup &&
          (teamMatches(home, p.matchup) || teamMatches(away, p.matchup)));
      if (!teamOk) return false;
      if (!ev.date) return true;
      const ft = new Date(ev.date).getTime();
      if (!Number.isFinite(ft)) return true;
      return Math.abs(ft - anchor) < PROP_PROXIMITY_MS;
    });
    if (!match) {
      unmatched++;
      continue;
    }
    const competitors = match.competitions?.[0]?.competitors ?? [];
    const home = competitors.find(c => c.homeAway === "home");
    const away = competitors.find(c => c.homeAway === "away");
    const homeScore = parseInt(home?.score ?? "", 10);
    const awayScore = parseInt(away?.score ?? "", 10);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
      unmatched++;
      continue;
    }

    const homeName = home?.team?.displayName ?? "";
    const awayName = away?.team?.displayName ?? "";

    let result: "win" | "loss" | "push" | null = null;
    let actualValue: number | null = null;
    let note = "";

    if (p.market === "moneyline") {
      const pickedHome = teamMatches(homeName, p.selection);
      const pickedAway = teamMatches(awayName, p.selection);
      if (!pickedHome && !pickedAway) {
        unmatched++;
        continue;
      }
      const homeWon = homeScore > awayScore;
      result =
        homeScore === awayScore ? "push" : pickedHome ? (homeWon ? "win" : "loss") : homeWon ? "loss" : "win";
      actualValue = pickedHome ? homeScore - awayScore : awayScore - homeScore;
      note = `auto-graded ML vs ESPN final: ${awayName} ${awayScore} @ ${homeName} ${homeScore}`;
    } else if (p.market === "spread" && p.line !== null) {
      // Spread interpretation: selection contains team name + line number.
      // pickedHome takes (homeScore + p.line) > awayScore. Spread sign convention:
      // p.line is the spread the picked team is "taking" (favorites get -X, dogs get +X).
      const pickedHome = teamMatches(homeName, p.selection);
      const pickedAway = teamMatches(awayName, p.selection);
      if (!pickedHome && !pickedAway) {
        unmatched++;
        continue;
      }
      const adjustedScoreDiff = pickedHome ? homeScore + p.line - awayScore : awayScore + p.line - homeScore;
      result = adjustedScoreDiff === 0 ? "push" : adjustedScoreDiff > 0 ? "win" : "loss";
      actualValue = adjustedScoreDiff;
      note = `auto-graded spread (${p.line}) vs ESPN final: ${awayName} ${awayScore} @ ${homeName} ${homeScore} = ${adjustedScoreDiff > 0 ? "+" : ""}${adjustedScoreDiff.toFixed(1)}`;
    } else if (p.market === "total" && p.line !== null) {
      // Total: selection contains "Over X" or "Under X". Compare to home + away.
      const total = homeScore + awayScore;
      const isOver = /^over\b/i.test(p.selection.trim());
      const isUnder = /^under\b/i.test(p.selection.trim());
      if (!isOver && !isUnder) {
        unmatched++;
        continue;
      }
      result = total === p.line ? "push" : isOver ? (total > p.line ? "win" : "loss") : total < p.line ? "win" : "loss";
      actualValue = total;
      note = `auto-graded total (${p.line}) vs ESPN final: ${awayName} ${awayScore} @ ${homeName} ${homeScore} = ${total}`;
    } else {
      unmatched++;
      continue;
    }

    await prisma.modelPickSnapshot.update({
      where: { id: p.id },
      data: {
        result,
        actualValue,
        notes: note,
        gradedAt: new Date(),
      },
    });
    graded++;
  }
  return { graded, unmatched };
}

// ─── orchestrator ──────────────────────────────────────────────────────────

export type SnapshotGradeReport = {
  ranAt: string;
  daysBack: number;
  propsGraded: number;
  propsUnmatched: number;
  marketGraded: number;
  marketUnmatched: number;
};

export async function gradeAllSnapshots(daysBack = 1): Promise<SnapshotGradeReport> {
  const props = await gradeProps(daysBack);
  const market = await gradeMarketPicks(daysBack);
  return {
    ranAt: new Date().toISOString(),
    daysBack,
    propsGraded: props.graded,
    propsUnmatched: props.unmatched,
    marketGraded: market.graded,
    marketUnmatched: market.unmatched,
  };
}
