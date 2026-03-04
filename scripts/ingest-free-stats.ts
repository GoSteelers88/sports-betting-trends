import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildFreeStatsSummary, type FreeStatLike } from "../src/lib/free-stats-summary";
import { normalizeAtsResult, normalizeSpread } from "../src/lib/ats";

const prisma = new PrismaClient();
const root = process.cwd();

const DEFAULT_DAYS_BACK = 30;

const MLB_DIVISIONS: Record<string, string> = {
  BAL: "AL East",
  BOS: "AL East",
  NYY: "AL East",
  TB: "AL East",
  TOR: "AL East",
  CWS: "AL Central",
  CLE: "AL Central",
  DET: "AL Central",
  KC: "AL Central",
  MIN: "AL Central",
  HOU: "AL West",
  LAA: "AL West",
  OAK: "AL West",
  SEA: "AL West",
  TEX: "AL West",
  ATL: "NL East",
  MIA: "NL East",
  NYM: "NL East",
  PHI: "NL East",
  WSH: "NL East",
  CHC: "NL Central",
  CIN: "NL Central",
  MIL: "NL Central",
  PIT: "NL Central",
  STL: "NL Central",
  ARI: "NL West",
  COL: "NL West",
  LAD: "NL West",
  SD: "NL West",
  SF: "NL West",
};

const NBA_CONFERENCES: Record<string, string> = {
  // Eastern - Atlantic
  BOS: "Eastern", BKN: "Eastern", NYK: "Eastern", PHI: "Eastern", TOR: "Eastern",
  // Eastern - Central
  CHI: "Eastern", CLE: "Eastern", DET: "Eastern", IND: "Eastern", MIL: "Eastern",
  // Eastern - Southeast
  ATL: "Eastern", CHA: "Eastern", MIA: "Eastern", ORL: "Eastern", WSH: "Eastern",
  // Western - Northwest
  DEN: "Western", MIN: "Western", OKC: "Western", POR: "Western", UTA: "Western",
  // Western - Pacific
  GSW: "Western", LAC: "Western", LAL: "Western", PHX: "Western", SAC: "Western",
  // Western - Southwest
  DAL: "Western", HOU: "Western", MEM: "Western", NOP: "Western", SAS: "Western",
};

const NFL_DIVISIONS: Record<string, string> = {
  // AFC
  BUF: "AFC East", MIA: "AFC East", NE: "AFC East", NYJ: "AFC East",
  BAL: "AFC North", CIN: "AFC North", CLE: "AFC North", PIT: "AFC North",
  HOU: "AFC South", IND: "AFC South", JAX: "AFC South", TEN: "AFC South",
  DEN: "AFC West", KC: "AFC West", LV: "AFC West", LAC: "AFC West",
  // NFC
  DAL: "NFC East", NYG: "NFC East", PHI: "NFC East", WSH: "NFC East",
  CHI: "NFC North", DET: "NFC North", GB: "NFC North", MIN: "NFC North",
  ATL: "NFC South", CAR: "NFC South", NO: "NFC South", TB: "NFC South",
  ARI: "NFC West", LAR: "NFC West", SEA: "NFC West", SF: "NFC West",
};

type NBARecord = {
  date: string;
  team: string;
  opponent: string;
  points: string;
  rebounds: string;
  assists: string;
  source: string;
  game_status?: string;
  completion_evidence?: string;
};

type NFLRecord = {
  date: string;
  team: string;
  opponent: string;
  points: number;
  yards: number;
  source: string;
  game_status?: string;
  completion_evidence?: string;
};

type NCAABRecord = {
  date: string;
  conference: string;
  team: string;
  opponent: string;
  points: string;
  opponent_points: string;
  rebounds: string;
  assists: string;
  spread: string;
  ats_result: string;
  team_rank: string;
  opponent_rank: string;
  bubble_status: string;
  auto_bid_status: string;
  source: string;
  source_event_id?: string;
  game_status?: string;
  completion_evidence?: string;
};

type MLBRecord = {
  date: string;
  division: string;
  team: string;
  opponent: string;
  points: string;
  opponent_points: string;
  rebounds: string;
  assists: string;
  spread: string;
  ats_result: string;
  source: string;
  source_event_id?: string;
  game_status?: string;
  completion_evidence?: string;
};

type EspnEvent = {
  id: string;
  date: string;
  competitions?: Array<{
    status?: { type?: { completed?: boolean; name?: string; state?: string; description?: string; detail?: string } };
    competitors?: Array<{
      homeAway?: "home" | "away";
      score?: string;
      records?: Array<{ type?: string; summary?: string }>;
      curatedRank?: { current?: number };
      team?: { shortDisplayName?: string; displayName?: string; id?: string; abbreviation?: string };
      statistics?: Array<{ name?: string; displayValue?: string }>;
      linescores?: Array<{ value?: number }>;
    }>;
    odds?: Array<Record<string, unknown>>;
  }>;
};

// Shape returned from ESPN summary API
type EspnSummary = Record<string, unknown>;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current.trim());
  return out;
}

function parseCsv<T = Record<string, string>>(csv: string): T[] {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const out: Record<string, string> = {};
    headers.forEach((header, i) => {
      out[header] = values[i] ?? "";
    });
    return out as T;
  });
}

function nullableNumber(value: string | number | null | undefined) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseRecord(summary?: string | null) {
  if (!summary) return { wins: 0, losses: 0, pct: 0 };
  const m = summary.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return { wins: 0, losses: 0, pct: 0 };
  const wins = Number(m[1]);
  const losses = Number(m[2]);
  const total = wins + losses;
  return { wins, losses, pct: total > 0 ? wins / total : 0 };
}

function getEspnGameStatus(event: EspnEvent) {
  const type = event.competitions?.[0]?.status?.type;
  return type?.description || type?.detail || type?.name || type?.state || (type?.completed ? "STATUS_FINAL" : "STATUS_UNKNOWN");
}

function classifyBubbleStatus(teamRank: number | null, overallPct: number, confPct: number, conference: string) {
  const power = ["ACC", "BIG TEN", "BIG 12", "BIG EAST", "SEC", "PAC-12"].includes(conference.toUpperCase());
  if ((teamRank != null && teamRank <= 20) || (overallPct >= 0.74 && confPct >= 0.58)) return "LOCK";
  if ((teamRank != null && teamRank <= 45) || overallPct >= 0.62) return "WORK";
  if ((teamRank != null && teamRank <= 75) || (power && overallPct >= 0.48 && overallPct <= 0.64)) return "BUBBLE";
  return "OUT";
}

function classifyAutoBidStatus(confPct: number, conference: string) {
  const power = ["ACC", "BIG TEN", "BIG 12", "BIG EAST", "SEC", "PAC-12"].includes(conference.toUpperCase());
  if (confPct >= 0.72) return "AUTO_BID";
  if (!power && confPct >= 0.62) return "AUTO_BID";
  return "AT_LARGE_TRACK";
}

function dateStr(d: Date) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- ESPN Summary fetchers by sport ----------

async function fetchEspnSummary(sport: string, eventId: string): Promise<EspnSummary | null> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "sports-betting-trends/1.0" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return (await res.json()) as EspnSummary;
  } catch {
    return null;
  }
}

function conferenceFromSummary(summary: EspnSummary) {
  const standings = summary.standings as { groups?: Array<{ header?: string }> } | undefined;
  const header = standings?.groups?.[0]?.header;
  if (!header) return "Unknown";
  return header.replace(/^\d{4}-\d{2}\s+/, "").replace(/\s+Standings$/i, "").trim() || "Unknown";
}

function statFromBoxscore(summary: EspnSummary, teamIdx: number, statName: string): number | null {
  const boxscore = summary.boxscore as { teams?: Array<{ statistics?: Array<{ name?: string; displayValue?: string }> }> } | undefined;
  const stats = boxscore?.teams?.[teamIdx]?.statistics ?? [];
  const found = stats.find((s) => s.name === statName);
  return found ? nullableNumber(found.displayValue) : null;
}

function statFromPlayerBoxscore(summary: EspnSummary, teamIdx: number, statName: string): number | null {
  const boxscore = summary.boxscore as {
    players?: Array<{
      statistics?: Array<{
        names?: string[];
        totals?: string[];
      }>;
    }>;
  } | undefined;
  const playerTeam = boxscore?.players?.[teamIdx];
  const statGroups = playerTeam?.statistics ?? [];
  for (const group of statGroups) {
    const names = group.names ?? [];
    const totals = group.totals ?? [];
    const idx = names.findIndex((n) => n?.toUpperCase() === statName.toUpperCase());
    if (idx >= 0 && totals[idx] != null) {
      return nullableNumber(totals[idx]);
    }
  }
  return null;
}

// Helper: parse "M-A" (e.g., "35-78") into {made, attempted}
function parseMadeAttempted(value: string | null | undefined): { made: number | null; attempted: number | null } {
  if (!value) return { made: null, attempted: null };
  const m = value.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return { made: null, attempted: null };
  return { made: Number(m[1]), attempted: Number(m[2]) };
}

// Parse time of possession "MM:SS" or "M:SS" to minutes as float
function parseTimeOfPossession(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.match(/(\d+):(\d+)/);
  if (!m) return nullableNumber(value);
  return Number(m[1]) + Number(m[2]) / 60;
}

// ---------- Shared helper: collect completed events from scoreboard ----------

async function collectCompletedEvents(sport: string, daysBack: number, limit = 500, groups?: string): Promise<EspnEvent[]> {
  const seen = new Set<string>();
  const events: EspnEvent[] = [];

  for (let d = 0; d < daysBack; d += 1) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    const date = dateStr(day);

    let boardUrl = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard?limit=${limit}&dates=${date}`;
    if (groups) boardUrl += `&groups=${groups}`;

    try {
      const boardRes = await fetch(boardUrl, { headers: { "User-Agent": "sports-betting-trends/1.0" }, signal: AbortSignal.timeout(10000) });
      if (!boardRes.ok) continue;
      const board = (await boardRes.json()) as { events?: EspnEvent[] };

      for (const event of board.events ?? []) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        const competition = event.competitions?.[0];
        if (!competition?.status?.type?.completed) continue;
        if ((competition.competitors ?? []).length !== 2) continue;
        events.push(event);
      }
    } catch {
      continue;
    }
  }

  return events;
}

// ---------- NBA Live Ingestion ----------

type IngestRow = {
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
  // Box score
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
  // Universal
  homeAway: string | null;
  hits: number | null;
  errors: number | null;
  // Meta
  source: string;
  sourceEventId: string | null;
  gameStatus: string;
  completionEvidence: string;
};

const NULL_BOX: Pick<IngestRow, "fgm" | "fga" | "threepm" | "threepa" | "ftm" | "fta" | "offRebounds" | "defRebounds" | "steals" | "blocks" | "turnovers" | "passingYards" | "rushingYards" | "opponentYards" | "turnoversFor" | "turnoversAgainst" | "thirdDownConv" | "thirdDownAtt" | "redZoneConv" | "redZoneAtt" | "timeOfPossession" | "homeAway" | "hits" | "errors"> = {
  fgm: null, fga: null, threepm: null, threepa: null, ftm: null, fta: null,
  offRebounds: null, defRebounds: null, steals: null, blocks: null, turnovers: null,
  passingYards: null, rushingYards: null, opponentYards: null,
  turnoversFor: null, turnoversAgainst: null,
  thirdDownConv: null, thirdDownAtt: null, redZoneConv: null, redZoneAtt: null,
  timeOfPossession: null, homeAway: null, hits: null, errors: null,
};

async function fetchNbaRecentRows(daysBack: number): Promise<IngestRow[]> {
  const rows: IngestRow[] = [];
  const events = await collectCompletedEvents("basketball/nba", daysBack);
  console.log(`NBA: found ${events.length} completed events over ${daysBack} days`);

  const chunkSize = 8;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const summaries = await Promise.all(
      chunk.map(async (event) => ({ event, summary: await fetchEspnSummary("basketball/nba", event.id) })),
    );

    for (const { event, summary } of summaries) {
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      if (competitors.length !== 2) continue;

      const pick = summary
        ? ((summary.pickcenter as Array<Record<string, unknown>> | undefined) ?? [])[0]
        : ((competition?.odds ?? [])[0] ?? undefined);
      const spreadValue = normalizeSpread((pick?.spread as number | string | undefined) ?? (pick?.details as string | undefined) ?? "");

      for (let ci = 0; ci < competitors.length; ci++) {
        const comp = competitors[ci];
        const opponentIdx = ci === 0 ? 1 : 0;
        const opponent = competitors[opponentIdx];

        const points = nullableNumber(comp.score) ?? 0;
        const opponentPoints = nullableNumber(opponent.score) ?? 0;
        const compStats = comp.statistics ?? [];
        const rebounds = nullableNumber(compStats.find((s) => s.name === "rebounds")?.displayValue ?? "");
        const assists = nullableNumber(compStats.find((s) => s.name === "assists")?.displayValue ?? "");

        // Box score from summary
        let fgm: number | null = null, fga: number | null = null;
        let threepm: number | null = null, threepa: number | null = null;
        let ftm: number | null = null, fta: number | null = null;
        let offRebounds: number | null = null, defRebounds: number | null = null;
        let steals: number | null = null, blocks: number | null = null, turnovers: number | null = null;

        if (summary) {
          // Try team-level boxscore stats
          fgm = statFromBoxscore(summary, ci, "fieldGoalsMade");
          fga = statFromBoxscore(summary, ci, "fieldGoalsAttempted");
          threepm = statFromBoxscore(summary, ci, "threePointFieldGoalsMade");
          threepa = statFromBoxscore(summary, ci, "threePointFieldGoalsAttempted");
          ftm = statFromBoxscore(summary, ci, "freeThrowsMade");
          fta = statFromBoxscore(summary, ci, "freeThrowsAttempted");
          offRebounds = statFromBoxscore(summary, ci, "offensiveRebounds");
          defRebounds = statFromBoxscore(summary, ci, "defensiveRebounds");
          steals = statFromBoxscore(summary, ci, "steals");
          blocks = statFromBoxscore(summary, ci, "blocks");
          turnovers = statFromBoxscore(summary, ci, "turnovers") ?? statFromBoxscore(summary, ci, "totalTurnovers");

          // Fallback: try player box score totals if team stats not found
          if (fgm == null) {
            const fgStr = statFromPlayerBoxscore(summary, ci, "FG")?.toString();
            if (!fgStr) {
              fgm = statFromPlayerBoxscore(summary, ci, "FGM");
              fga = statFromPlayerBoxscore(summary, ci, "FGA");
            }
          }
          if (threepm == null) {
            threepm = statFromPlayerBoxscore(summary, ci, "3PM");
            threepa = statFromPlayerBoxscore(summary, ci, "3PA");
          }
          if (ftm == null) {
            ftm = statFromPlayerBoxscore(summary, ci, "FTM");
            fta = statFromPlayerBoxscore(summary, ci, "FTA");
          }
          if (offRebounds == null) offRebounds = statFromPlayerBoxscore(summary, ci, "OREB");
          if (defRebounds == null) defRebounds = statFromPlayerBoxscore(summary, ci, "DREB");
          if (steals == null) steals = statFromPlayerBoxscore(summary, ci, "STL");
          if (blocks == null) blocks = statFromPlayerBoxscore(summary, ci, "BLK");
          if (turnovers == null) turnovers = statFromPlayerBoxscore(summary, ci, "TO");
        }

        const teamSpread = comp.homeAway === "home" ? spreadValue : spreadValue == null ? null : -spreadValue;
        const ats = normalizeAtsResult(null, points, opponentPoints, teamSpread);

        // Skip All-Star / exhibition teams that are not real NBA franchises
        const nbaAbbr = comp.team?.abbreviation ?? "";
        if (!NBA_CONFERENCES[nbaAbbr]) continue;

        rows.push({
          league: "NBA",
          conference: NBA_CONFERENCES[nbaAbbr] ?? null,
          gameDate: new Date(event.date.slice(0, 10)),
          team: comp.team?.shortDisplayName ?? comp.team?.displayName ?? "Unknown",
          opponent: opponent.team?.shortDisplayName ?? opponent.team?.displayName ?? "Unknown",
          points,
          opponentPoints,
          rebounds,
          assists,
          yards: null,
          spread: teamSpread,
          atsResult: ats,
          won: points > opponentPoints,
          teamRank: null,
          opponentRank: null,
          bubbleStatus: null,
          autoBidStatus: null,
          fgm, fga, threepm, threepa, ftm, fta,
          offRebounds, defRebounds, steals, blocks, turnovers,
          passingYards: null, rushingYards: null, opponentYards: null,
          turnoversFor: null, turnoversAgainst: null,
          thirdDownConv: null, thirdDownAtt: null,
          redZoneConv: null, redZoneAtt: null,
          timeOfPossession: null,
          homeAway: comp.homeAway ?? null,
          hits: null, errors: null,
          source: "espn-public-api",
          sourceEventId: event.id,
          gameStatus: getEspnGameStatus(event),
          completionEvidence: "espn-status-completed",
        });
      }
    }
  }

  return rows;
}

// ---------- NFL Live Ingestion ----------

async function fetchNflRecentRows(daysBack: number): Promise<IngestRow[]> {
  const rows: IngestRow[] = [];
  const events = await collectCompletedEvents("football/nfl", daysBack);
  console.log(`NFL: found ${events.length} completed events over ${daysBack} days`);

  const chunkSize = 8;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const summaries = await Promise.all(
      chunk.map(async (event) => ({ event, summary: await fetchEspnSummary("football/nfl", event.id) })),
    );

    for (const { event, summary } of summaries) {
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      if (competitors.length !== 2) continue;

      const pick = summary
        ? ((summary.pickcenter as Array<Record<string, unknown>> | undefined) ?? [])[0]
        : ((competition?.odds ?? [])[0] ?? undefined);
      const spreadValue = normalizeSpread((pick?.spread as number | string | undefined) ?? (pick?.details as string | undefined) ?? "");

      for (let ci = 0; ci < competitors.length; ci++) {
        const comp = competitors[ci];
        const opponentIdx = ci === 0 ? 1 : 0;
        const opponent = competitors[opponentIdx];

        const points = nullableNumber(comp.score) ?? 0;
        const opponentPoints = nullableNumber(opponent.score) ?? 0;
        const compStats = comp.statistics ?? [];
        const yardsVal = nullableNumber(compStats.find((s) => s.name === "totalYards" || s.name === "netYards")?.displayValue ?? "");

        // NFL box score from summary
        let passingYards: number | null = null, rushingYards: number | null = null;
        let opponentYards: number | null = null;
        let turnoversFor: number | null = null, turnoversAgainst: number | null = null;
        let thirdDownConv: number | null = null, thirdDownAtt: number | null = null;
        let redZoneConv: number | null = null, redZoneAtt: number | null = null;
        let timeOfPossession: number | null = null;

        if (summary) {
          passingYards = statFromBoxscore(summary, ci, "netPassingYards") ?? statFromBoxscore(summary, ci, "passingYards");
          rushingYards = statFromBoxscore(summary, ci, "rushingYards");
          opponentYards = statFromBoxscore(summary, opponentIdx, "totalYards") ?? statFromBoxscore(summary, opponentIdx, "netYards");

          // Turnovers: team forced = opponent's turnovers, turnovers against = team's own
          turnoversAgainst = statFromBoxscore(summary, ci, "turnovers") ?? statFromBoxscore(summary, ci, "totalTurnovers");
          turnoversFor = statFromBoxscore(summary, opponentIdx, "turnovers") ?? statFromBoxscore(summary, opponentIdx, "totalTurnovers");

          // Third down: try "thirdDownEff" which is often "M/A" format
          const thirdDownEffVal = (() => {
            const bs = summary.boxscore as { teams?: Array<{ statistics?: Array<{ name?: string; displayValue?: string }> }> } | undefined;
            return bs?.teams?.[ci]?.statistics?.find((s) => s.name === "thirdDownEff")?.displayValue ?? null;
          })();
          if (thirdDownEffVal) {
            const parsed = parseMadeAttempted(thirdDownEffVal);
            thirdDownConv = parsed.made;
            thirdDownAtt = parsed.attempted;
          } else {
            thirdDownConv = statFromBoxscore(summary, ci, "thirdDownConversions");
            thirdDownAtt = statFromBoxscore(summary, ci, "thirdDownAttempts");
          }

          // Red zone
          const rzEffVal = (() => {
            const bs = summary.boxscore as { teams?: Array<{ statistics?: Array<{ name?: string; displayValue?: string }> }> } | undefined;
            return bs?.teams?.[ci]?.statistics?.find((s) => s.name === "redZoneEff" || s.name === "redZoneAttempts")?.displayValue ?? null;
          })();
          if (rzEffVal) {
            const parsed = parseMadeAttempted(rzEffVal);
            redZoneConv = parsed.made;
            redZoneAtt = parsed.attempted;
          }

          // Time of possession
          const topVal = (() => {
            const bs = summary.boxscore as { teams?: Array<{ statistics?: Array<{ name?: string; displayValue?: string }> }> } | undefined;
            return bs?.teams?.[ci]?.statistics?.find((s) => s.name === "possessionTime" || s.name === "timeOfPossession")?.displayValue ?? null;
          })();
          timeOfPossession = parseTimeOfPossession(topVal);
        }

        const teamSpread = comp.homeAway === "home" ? spreadValue : spreadValue == null ? null : -spreadValue;
        const ats = normalizeAtsResult(null, points, opponentPoints, teamSpread);

        rows.push({
          league: "NFL",
          conference: NFL_DIVISIONS[comp.team?.abbreviation ?? ""] ?? null,
          gameDate: new Date(event.date.slice(0, 10)),
          team: comp.team?.abbreviation ?? comp.team?.shortDisplayName ?? comp.team?.displayName ?? "Unknown",
          opponent: opponent.team?.abbreviation ?? opponent.team?.shortDisplayName ?? opponent.team?.displayName ?? "Unknown",
          points,
          opponentPoints,
          rebounds: null,
          assists: null,
          yards: yardsVal,
          spread: teamSpread,
          atsResult: ats,
          won: points > opponentPoints,
          teamRank: null,
          opponentRank: null,
          bubbleStatus: null,
          autoBidStatus: null,
          fgm: null, fga: null, threepm: null, threepa: null, ftm: null, fta: null,
          offRebounds: null, defRebounds: null, steals: null, blocks: null, turnovers: null,
          passingYards, rushingYards, opponentYards,
          turnoversFor, turnoversAgainst,
          thirdDownConv, thirdDownAtt,
          redZoneConv, redZoneAtt,
          timeOfPossession,
          homeAway: comp.homeAway ?? null,
          hits: null, errors: null,
          source: "espn-public-api",
          sourceEventId: event.id,
          gameStatus: getEspnGameStatus(event),
          completionEvidence: "espn-status-completed",
        });
      }
    }
  }

  return rows;
}

// ---------- NCAAB Live Ingestion (enhanced with box score + homeAway) ----------

async function fetchNcaabRecentRows(daysBack: number): Promise<IngestRow[]> {
  const rows: IngestRow[] = [];

  // Build conference lookup from standings-ncaab.json (covers all 365 D1 teams)
  type NcaabStandingEntry = { team: string; abbreviation: string; conference: string };
  const ncaabStandingsPath = path.join(root, "data/processed/standings-ncaab.json");
  const ncaabStandingsRaw: NcaabStandingEntry[] = fs.existsSync(ncaabStandingsPath)
    ? (JSON.parse(fs.readFileSync(ncaabStandingsPath, "utf8")) as NcaabStandingEntry[])
    : [];
  const ncaabConfByName = new Map<string, string>();
  const ncaabConfByAbbr = new Map<string, string>();
  for (const entry of ncaabStandingsRaw) {
    if (entry.team) ncaabConfByName.set(entry.team.toLowerCase(), entry.conference);
    if (entry.abbreviation) ncaabConfByAbbr.set(entry.abbreviation.toUpperCase(), entry.conference);
  }
  const getTeamConf = (team: Record<string, unknown> | undefined): string => {
    if (!team) return "Unknown";
    const byAbbr = ncaabConfByAbbr.get(String(team.abbreviation ?? "").toUpperCase());
    if (byAbbr) return byAbbr;
    const byName = ncaabConfByName.get(String(team.displayName ?? "").toLowerCase());
    if (byName) return byName;
    return conferenceFromSummary({} as EspnSummary); // last-resort fallback
  };

  const events = await collectCompletedEvents("basketball/mens-college-basketball", daysBack, 500, "50");
  console.log(`NCAAB: found ${events.length} completed events over ${daysBack} days`);

  const chunkSize = 8;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const summaries = await Promise.all(
      chunk.map(async (event) => ({ event, summary: await fetchEspnSummary("basketball/mens-college-basketball", event.id) })),
    );

    for (const { event, summary } of summaries) {
      if (!summary) continue;
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      if (competitors.length !== 2) continue;

      const pick = ((summary.pickcenter as Array<Record<string, unknown>> | undefined) ?? [])[0];
      const spreadValue = normalizeSpread((pick?.spread as number | string | undefined) ?? (pick?.details as string | undefined) ?? "");

      for (let ci = 0; ci < competitors.length; ci++) {
        const comp = competitors[ci];
        const opponentIdx = ci === 0 ? 1 : 0;
        const opponent = competitors[opponentIdx];
        const conference = getTeamConf(comp.team as Record<string, unknown>);

        const points = nullableNumber(comp.score) ?? 0;
        const opponentPoints = nullableNumber(opponent.score) ?? 0;
        const compStats = comp.statistics ?? [];
        const rebounds = nullableNumber(compStats.find((s) => s.name === "rebounds")?.displayValue ?? "");
        const assists = nullableNumber(compStats.find((s) => s.name === "assists")?.displayValue ?? "");
        const teamRank = nullableNumber(comp.curatedRank?.current ?? null);
        const oppRank = nullableNumber(opponent.curatedRank?.current ?? null);

        const overall = parseRecord(comp.records?.find((r) => r.type === "total")?.summary);
        const confRecord = parseRecord(comp.records?.find((r) => r.type === "vsconf")?.summary);
        const bubbleStatus = classifyBubbleStatus(teamRank, overall.pct, confRecord.pct, conference);
        const autoBidStatus = classifyAutoBidStatus(confRecord.pct, conference);

        // Box score from summary
        let fgm: number | null = null, fga: number | null = null;
        let threepm: number | null = null, threepa: number | null = null;
        let ftm: number | null = null, fta: number | null = null;
        let offRebounds: number | null = null, defRebounds: number | null = null;
        let steals: number | null = null, blocks: number | null = null, turnovers: number | null = null;

        fgm = statFromBoxscore(summary, ci, "fieldGoalsMade");
        fga = statFromBoxscore(summary, ci, "fieldGoalsAttempted");
        threepm = statFromBoxscore(summary, ci, "threePointFieldGoalsMade");
        threepa = statFromBoxscore(summary, ci, "threePointFieldGoalsAttempted");
        ftm = statFromBoxscore(summary, ci, "freeThrowsMade");
        fta = statFromBoxscore(summary, ci, "freeThrowsAttempted");
        offRebounds = statFromBoxscore(summary, ci, "offensiveRebounds");
        defRebounds = statFromBoxscore(summary, ci, "defensiveRebounds");
        steals = statFromBoxscore(summary, ci, "steals");
        blocks = statFromBoxscore(summary, ci, "blocks");
        turnovers = statFromBoxscore(summary, ci, "turnovers") ?? statFromBoxscore(summary, ci, "totalTurnovers");

        // Fallback to player totals
        if (fgm == null) {
          fgm = statFromPlayerBoxscore(summary, ci, "FGM");
          fga = statFromPlayerBoxscore(summary, ci, "FGA");
        }
        if (threepm == null) {
          threepm = statFromPlayerBoxscore(summary, ci, "3PM");
          threepa = statFromPlayerBoxscore(summary, ci, "3PA");
        }
        if (ftm == null) {
          ftm = statFromPlayerBoxscore(summary, ci, "FTM");
          fta = statFromPlayerBoxscore(summary, ci, "FTA");
        }
        if (offRebounds == null) offRebounds = statFromPlayerBoxscore(summary, ci, "OREB");
        if (defRebounds == null) defRebounds = statFromPlayerBoxscore(summary, ci, "DREB");
        if (steals == null) steals = statFromPlayerBoxscore(summary, ci, "STL");
        if (blocks == null) blocks = statFromPlayerBoxscore(summary, ci, "BLK");
        if (turnovers == null) turnovers = statFromPlayerBoxscore(summary, ci, "TO");

        const teamSpread = comp.homeAway === "home" ? spreadValue : spreadValue == null ? null : -spreadValue;
        const ats = normalizeAtsResult(null, points, opponentPoints, teamSpread);

        rows.push({
          league: "NCAAB",
          conference,
          gameDate: new Date(event.date.slice(0, 10)),
          team: comp.team?.shortDisplayName ?? comp.team?.displayName ?? "Unknown",
          opponent: opponent.team?.shortDisplayName ?? opponent.team?.displayName ?? "Unknown",
          points,
          opponentPoints,
          rebounds,
          assists,
          yards: null,
          spread: teamSpread,
          atsResult: ats,
          won: points > opponentPoints,
          teamRank,
          opponentRank: oppRank,
          bubbleStatus,
          autoBidStatus,
          fgm, fga, threepm, threepa, ftm, fta,
          offRebounds, defRebounds, steals, blocks, turnovers,
          passingYards: null, rushingYards: null, opponentYards: null,
          turnoversFor: null, turnoversAgainst: null,
          thirdDownConv: null, thirdDownAtt: null,
          redZoneConv: null, redZoneAtt: null,
          timeOfPossession: null,
          homeAway: comp.homeAway ?? null,
          hits: null, errors: null,
          source: "espn-public-api",
          sourceEventId: event.id,
          gameStatus: getEspnGameStatus(event),
          completionEvidence: "espn-status-completed",
        });
      }
    }
  }

  return rows;
}

// ---------- MLB Live Ingestion (enhanced with summary API + hits/errors) ----------

async function fetchMlbRecentRows(daysBack: number): Promise<IngestRow[]> {
  const rows: IngestRow[] = [];
  const events = await collectCompletedEvents("baseball/mlb", daysBack, 200);
  console.log(`MLB: found ${events.length} completed events over ${daysBack} days`);

  const chunkSize = 8;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const summaries = await Promise.all(
      chunk.map(async (event) => ({ event, summary: await fetchEspnSummary("baseball/mlb", event.id) })),
    );

    for (const { event, summary } of summaries) {
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      if (competitors.length !== 2) continue;

      const pick = summary
        ? ((summary.pickcenter as Array<Record<string, unknown>> | undefined) ?? [])[0]
        : ((competition?.odds ?? [])[0] ?? undefined);
      const spreadValue = normalizeSpread((pick?.spread as number | string | undefined) ?? (pick?.details as string | undefined) ?? "");

      for (let ci = 0; ci < competitors.length; ci++) {
        const comp = competitors[ci];
        const opponentIdx = ci === 0 ? 1 : 0;
        const opponent = competitors[opponentIdx];

        const runs = nullableNumber(comp.score) ?? 0;
        const oppRuns = nullableNumber(opponent.score) ?? 0;
        const compStats = comp.statistics ?? [];
        const hits = nullableNumber(compStats.find((s) => s.name === "hits")?.displayValue ?? "");
        const errorsVal = nullableNumber(compStats.find((s) => s.name === "errors")?.displayValue ?? "");

        // Also try summary boxscore for hits/errors
        let hitsFromSummary = hits;
        let errorsFromSummary = errorsVal;
        if (summary && hitsFromSummary == null) {
          hitsFromSummary = statFromBoxscore(summary, ci, "hits");
        }
        if (summary && errorsFromSummary == null) {
          errorsFromSummary = statFromBoxscore(summary, ci, "errors");
        }

        const abbr = comp.team?.abbreviation ?? comp.team?.shortDisplayName ?? "";
        const division = MLB_DIVISIONS[abbr] ?? "Unknown";

        const teamSpread = comp.homeAway === "home" ? spreadValue : spreadValue == null ? null : -spreadValue;
        const ats = normalizeAtsResult(null, runs, oppRuns, teamSpread);

        rows.push({
          league: "MLB",
          conference: division,
          gameDate: new Date(event.date.slice(0, 10)),
          team: comp.team?.shortDisplayName ?? comp.team?.displayName ?? abbr ?? "Unknown",
          opponent: opponent.team?.shortDisplayName ?? opponent.team?.displayName ?? "Unknown",
          points: runs,
          opponentPoints: oppRuns,
          rebounds: null,
          assists: null,
          yards: null,
          spread: teamSpread,
          atsResult: ats,
          won: runs > oppRuns,
          teamRank: null,
          opponentRank: null,
          bubbleStatus: null,
          autoBidStatus: null,
          ...NULL_BOX,
          homeAway: comp.homeAway ?? null,
          hits: hitsFromSummary,
          errors: errorsFromSummary,
          source: "espn-public-api",
          sourceEventId: event.id,
          gameStatus: getEspnGameStatus(event),
          completionEvidence: "espn-status-completed",
        });
      }
    }
  }

  return rows;
}

// ---------- Completion evidence ----------

// ─── ESPN Odds Fallback ──────────────────────────────────────────────────────
// Used automatically when The Odds API quota is exhausted (0 events for a league).
// Fetches DraftKings spreads from ESPN's public scoreboard API (no key required).

type EspnFallbackEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title: string;
    markets: Array<{ key: string; outcomes: Array<{ name: string; price?: number; point?: number }> }>;
  }>;
};

async function fetchEspnOddsAsFallback(
  league: "basketball_nba" | "basketball_ncaab",
): Promise<EspnFallbackEvent[]> {
  const espnLeague = league === "basketball_nba" ? "nba" : "mens-college-basketball";
  const sportTitle = league === "basketball_nba" ? "NBA" : "NCAAB";
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/${espnLeague}/scoreboard?limit=200`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0 (espn-odds-fallback)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`ESPN fallback: ${league} request failed (${res.status})`);
      return [];
    }
    const data = (await res.json()) as {
      events?: Array<{
        id: string;
        date: string;
        competitions?: Array<{
          competitors?: Array<{ homeAway: string; team: { displayName: string } }>;
          odds?: Array<{ spread?: number; details?: string }>;
        }>;
      }>;
    };

    const result: EspnFallbackEvent[] = [];
    for (const evt of data.events ?? []) {
      const comp = evt.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find((c) => c.homeAway === "home");
      const away = comp.competitors?.find((c) => c.homeAway === "away");
      if (!home || !away) continue;
      const odds = comp.odds?.[0];
      if (odds?.spread == null) continue;
      // ESPN `spread` = home team's point (negative means home is favored)
      const homePoint = odds.spread;
      const awayPoint = -odds.spread;
      result.push({
        id: `espn_${evt.id}`,
        sport_key: league,
        sport_title: sportTitle,
        commence_time: evt.date,
        home_team: home.team.displayName,
        away_team: away.team.displayName,
        bookmakers: [
          {
            key: "espn_draftkings",
            title: "ESPN/DraftKings",
            markets: [
              {
                key: "spreads",
                outcomes: [
                  { name: home.team.displayName, point: homePoint, price: -110 },
                  { name: away.team.displayName, point: awayPoint, price: -110 },
                ],
              },
            ],
          },
        ],
      });
    }
    console.log(`ESPN fallback: fetched ${result.length} ${league} events`);
    return result;
  } catch (err) {
    console.warn(`ESPN fallback error for ${league}:`, err);
    return [];
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function statusLooksCompleted(status?: string | null) {
  const s = (status ?? "").toUpperCase();
  if (!s) return false;
  if (s.includes("SCHEDULED") || s.includes("LIVE") || s.includes("IN_PROGRESS") || s.includes("PRE")) return false;
  return s.includes("FINAL") || s.includes("COMPLETE") || s.includes("POST");
}

function defaultGameStatus(source: string, status?: string) {
  if (status && status.trim()) return status;
  if (source.toLowerCase().includes("manual")) return "MANUAL_FINAL_UNVERIFIED";
  return "STATUS_UNKNOWN";
}

function hasCompletionEvidence(row: {
  gameDate: Date;
  points: number;
  opponentPoints?: number | null;
  yards?: number | null;
  rebounds?: number | null;
  assists?: number | null;
  won?: boolean | null;
  atsResult?: string | null;
  gameStatus?: string | null;
}) {
  if (row.gameDate.getTime() > Date.now()) return false;
  if (statusLooksCompleted(row.gameStatus)) return true;
  if (row.won != null) return true;
  if (row.atsResult === "W" || row.atsResult === "L" || row.atsResult === "P") return true;
  if (row.opponentPoints != null) return true;
  if (row.yards != null || row.rebounds != null || row.assists != null) return true;
  return Number.isFinite(row.points) && row.points > 0;
}

// ---------- Main ----------

async function main() {
  const nbaCsvPath = path.join(root, "data", "raw", "nba", "sample_team_stats.csv");
  const nflJsonPath = path.join(root, "data", "raw", "nfl", "sample_team_stats.json");
  const ncaabCsvPath = path.join(root, "data", "raw", "ncaab", "sample_team_stats.csv");
  const mlbCsvPath = path.join(root, "data", "raw", "mlb", "sample_team_stats.csv");

  // Per-league days back with env overrides
  const defaultDays = Number(process.env.DAYS_BACK ?? String(DEFAULT_DAYS_BACK));
  const nbaDaysBack = Number(process.env.NBA_DAYS_BACK ?? String(defaultDays));
  const nflDaysBack = Number(process.env.NFL_DAYS_BACK ?? String(defaultDays));
  const ncaabDaysBack = Number(process.env.NCAAB_DAYS_BACK ?? String(defaultDays));
  const mlbDaysBack = Number(process.env.MLB_DAYS_BACK ?? String(defaultDays));

  // Fetch all leagues from ESPN in parallel
  const [fetchedNbaRows, fetchedNflRows, fetchedNcaabRows, fetchedMlbRows] = await Promise.all([
    fetchNbaRecentRows(nbaDaysBack),
    fetchNflRecentRows(nflDaysBack),
    fetchNcaabRecentRows(ncaabDaysBack),
    fetchMlbRecentRows(mlbDaysBack),
  ]);

  // Fallbacks from static files
  const fallbackNbaRows: NBARecord[] = fs.existsSync(nbaCsvPath) ? parseCsv<NBARecord>(fs.readFileSync(nbaCsvPath, "utf8")) : [];
  const fallbackNflRows: NFLRecord[] = fs.existsSync(nflJsonPath) ? JSON.parse(fs.readFileSync(nflJsonPath, "utf8")) : [];
  const fallbackNcaabRows: NCAABRecord[] = fs.existsSync(ncaabCsvPath) ? parseCsv<NCAABRecord>(fs.readFileSync(ncaabCsvPath, "utf8")) : [];
  const fallbackMlbRows: MLBRecord[] = fs.existsSync(mlbCsvPath) ? parseCsv<MLBRecord>(fs.readFileSync(mlbCsvPath, "utf8")) : [];

  // Use ESPN rows if available, otherwise fall back to static
  const nbaRows = fetchedNbaRows.length ? fetchedNbaRows : fallbackNbaRows.map((row): IngestRow => ({
    league: "NBA",
    conference: NBA_CONFERENCES[row.team] ?? null,
    gameDate: new Date(row.date),
    team: row.team,
    opponent: row.opponent,
    points: Number(row.points),
    opponentPoints: null,
    rebounds: Number(row.rebounds),
    assists: Number(row.assists),
    yards: null,
    spread: null,
    atsResult: null,
    won: null,
    teamRank: null,
    opponentRank: null,
    bubbleStatus: null,
    autoBidStatus: null,
    ...NULL_BOX,
    source: row.source,
    sourceEventId: null,
    gameStatus: row.game_status ?? "MANUAL_FINAL_UNVERIFIED",
    completionEvidence: row.completion_evidence ?? "manual-boxscore-export",
  }));

  const nflRows = fetchedNflRows.length ? fetchedNflRows : fallbackNflRows.map((row): IngestRow => ({
    league: "NFL",
    conference: NFL_DIVISIONS[row.team] ?? null,
    gameDate: new Date(row.date),
    team: row.team,
    opponent: row.opponent,
    points: row.points,
    opponentPoints: null,
    rebounds: null,
    assists: null,
    yards: row.yards,
    spread: null,
    atsResult: null,
    won: null,
    teamRank: null,
    opponentRank: null,
    bubbleStatus: null,
    autoBidStatus: null,
    ...NULL_BOX,
    source: row.source,
    sourceEventId: null,
    gameStatus: row.game_status ?? "MANUAL_FINAL_UNVERIFIED",
    completionEvidence: row.completion_evidence ?? "manual-game-finder-export",
  }));

  const ncaabRows = fetchedNcaabRows.length ? fetchedNcaabRows : fallbackNcaabRows.map((row): IngestRow => {
    const points = Number(row.points);
    const opponentPoints = nullableNumber(row.opponent_points);
    const spread = normalizeSpread(row.spread);
    const ats = normalizeAtsResult(row.ats_result, points, opponentPoints, spread);
    return {
      league: "NCAAB",
      conference: row.conference || null,
      gameDate: new Date(row.date),
      team: row.team,
      opponent: row.opponent,
      points,
      opponentPoints,
      rebounds: nullableNumber(row.rebounds),
      assists: nullableNumber(row.assists),
      yards: null,
      spread,
      atsResult: ats,
      won: opponentPoints == null ? null : points > opponentPoints,
      teamRank: nullableNumber(row.team_rank),
      opponentRank: nullableNumber(row.opponent_rank),
      bubbleStatus: row.bubble_status || null,
      autoBidStatus: row.auto_bid_status || null,
      ...NULL_BOX,
      source: row.source,
      sourceEventId: row.source_event_id ?? null,
      gameStatus: defaultGameStatus(row.source, row.game_status),
      completionEvidence: row.completion_evidence ?? "scored-game",
    };
  });

  const mlbRows = fetchedMlbRows.length ? fetchedMlbRows : fallbackMlbRows.map((row): IngestRow => {
    const runs = Number(row.points);
    const opponentRuns = nullableNumber(row.opponent_points);
    const spread = normalizeSpread(row.spread);
    const ats = normalizeAtsResult(row.ats_result, runs, opponentRuns, spread);
    return {
      league: "MLB",
      conference: row.division || null,
      gameDate: new Date(row.date),
      team: row.team,
      opponent: row.opponent,
      points: runs,
      opponentPoints: opponentRuns,
      rebounds: nullableNumber(row.rebounds),
      assists: nullableNumber(row.assists),
      yards: null,
      spread,
      atsResult: ats,
      won: opponentRuns == null ? null : runs > opponentRuns,
      teamRank: null,
      opponentRank: null,
      bubbleStatus: null,
      autoBidStatus: null,
      ...NULL_BOX,
      hits: null,
      errors: null,
      source: row.source,
      sourceEventId: row.source_event_id ?? null,
      gameStatus: defaultGameStatus(row.source, row.game_status),
      completionEvidence: row.completion_evidence ?? "scored-game",
    };
  });

  // Save raw ESPN dumps
  fs.mkdirSync(path.join(root, "data", "raw", "nba"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "raw", "nba", "latest_espn_nba.json"), JSON.stringify(fetchedNbaRows, null, 2));

  fs.mkdirSync(path.join(root, "data", "raw", "nfl"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "raw", "nfl", "latest_espn_nfl.json"), JSON.stringify(fetchedNflRows, null, 2));

  fs.mkdirSync(path.join(root, "data", "raw", "ncaab"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "raw", "ncaab", "latest_espn_ncaab.json"), JSON.stringify(fetchedNcaabRows, null, 2));

  fs.mkdirSync(path.join(root, "data", "raw", "mlb"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "raw", "mlb", "latest_espn_mlb.json"), JSON.stringify(fetchedMlbRows, null, 2));

  const records: IngestRow[] = [...nbaRows, ...nflRows, ...ncaabRows, ...mlbRows];

  const acceptedRecords = records.filter((r) => hasCompletionEvidence(r));
  const rejectedRecords = records.filter((r) => !hasCompletionEvidence(r));

  await prisma.freeStat.deleteMany();
  await prisma.freeStat.createMany({ data: acceptedRecords });

  const mapped: FreeStatLike[] = acceptedRecords.map((r) => ({
    ...r,
    conference: r.conference ?? null,
    gameDate: new Date(r.gameDate),
  }));

  const processedDir = path.join(root, "data", "processed");

  const oddsPath = path.join(processedDir, "latest-odds-api.json");
  const oddsPayload = fs.existsSync(oddsPath)
    ? (JSON.parse(fs.readFileSync(oddsPath, "utf8")) as { events?: unknown[] })
    : null;

  // Build merged odds array with three-tier fallback:
  // 1. Combined latest-odds-api.json (fresh from API)
  // 2. Per-league latest-odds-api-{league}.json (preserved from last successful API run)
  // 3. ESPN public scoreboard API (free, no key)
  const oddsEvents: unknown[] = (oddsPayload?.events as unknown[] | undefined) ?? [];
  const leaguesPresent = new Set(
    oddsEvents.map((e) => (e as { sport_key?: string }).sport_key).filter(Boolean),
  );
  for (const league of ["basketball_nba", "basketball_ncaab"] as const) {
    if (leaguesPresent.has(league)) continue;

    // Tier 2: per-league file (only overwritten when API succeeds — preserves last good data)
    const perLeaguePath = path.join(processedDir, `latest-odds-api-${league}.json`);
    const perLeaguePayload = fs.existsSync(perLeaguePath)
      ? (JSON.parse(fs.readFileSync(perLeaguePath, "utf8")) as { events?: unknown[]; fetchedAt?: string })
      : null;
    const perLeagueEvents = (perLeaguePayload?.events as unknown[] | undefined) ?? [];
    if (perLeagueEvents.length > 0) {
      console.log(`No ${league} odds in combined file — using preserved per-league file (${perLeagueEvents.length} events, fetched ${perLeaguePayload?.fetchedAt?.slice(0,10) ?? "unknown"})`);
      oddsEvents.push(...perLeagueEvents);
      leaguesPresent.add(league);
      continue;
    }

    // Tier 3: ESPN public API
    console.log(`No ${league} odds anywhere — fetching ESPN fallback...`);
    const espnEvents = await fetchEspnOddsAsFallback(league);
    oddsEvents.push(...espnEvents);
    if (espnEvents.length > 0) {
      fs.writeFileSync(
        path.join(processedDir, `scraped-odds-${league}.json`),
        JSON.stringify(
          { fetchedAt: new Date().toISOString(), source: "espn-fallback", league, eventCount: espnEvents.length, events: espnEvents },
          null,
          2,
        ),
      );
      console.log(`  -> saved scraped-odds-${league}.json (${espnEvents.length} events)`);
    }
  }

  function loadJson<T>(filePath: string): T | null {
    try { return fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as T) : null; }
    catch { return null; }
  }

  const standingsMap: Record<string, unknown[]> = {};
  for (const key of ["nba", "nfl", "mlb", "ncaab"]) {
    const data = loadJson<unknown[]>(path.join(processedDir, `standings-${key}.json`));
    if (data) standingsMap[key] = data;
  }
  // Refresh injury data if stale (>15 min old) — one call covers both leagues
  {
    const injCheckPath = path.join(processedDir, "injuries-nba.json");
    const needRefresh =
      !fs.existsSync(injCheckPath) ||
      Date.now() - fs.statSync(injCheckPath).mtimeMs > 15 * 60 * 1000;
    if (needRefresh) {
      console.log("  [ingest] Injury data stale — refreshing...");
      spawnSync("npx", ["tsx", "scripts/ingest-injuries.ts"], {
        stdio: "inherit",
        shell: true,
        timeout: 30_000,
        cwd: root,
      });
    }
  }

  // Load injuries — supports both legacy array format and new {fetchedAt, players} format
  const injuriesMap: Record<string, unknown[]> = {};
  for (const key of ["nba", "nfl"]) {
    const data = loadJson<unknown>(path.join(processedDir, `injuries-${key}.json`));
    if (Array.isArray(data)) {
      injuriesMap[key] = data;
    } else if (data && typeof data === "object" && "players" in data && Array.isArray((data as Record<string, unknown>).players)) {
      injuriesMap[key] = (data as Record<string, unknown[]>).players;
    }
  }

  // Load NBA efficiency ratings (independent model — generated by ingest:nba-efficiency)
  type NbaEffFile = { teams: Record<string, unknown> };
  const effData = loadJson<NbaEffFile>(path.join(processedDir, "nba-efficiency.json"));
  const nbaEfficiency = effData?.teams ? { teams: effData.teams } : undefined;

  const summary = buildFreeStatsSummary(mapped, {
    oddsEvents: oddsEvents as never[],
    standings: standingsMap as never,
    injuries: injuriesMap as never,
    nbaEfficiency: nbaEfficiency as never,
  });

  // ── ATS + Consensus enrichment (opt-in — skip silently if files absent) ──────
  {
    type EnrichableBet = {
      pickTeam: string; opponent: string; league: string; confidence: number;
      atsRecord?: { wins: number; losses: number; coverPct: number | null };
      publicConsensus?: "steam" | "fade";
      consensusNote?: string;
    };
    const betsToEnrich = (summary.bestBets as unknown as EnrichableBet[]) ?? [];

    if (betsToEnrich.length > 0) {
      type AtsTeam = {
        team: string;
        overall?: { wins: number; losses: number; coverPct: number | null };
      };
      type CGame = {
        awayAbbr: string; homeAbbr: string; matchup: string; league: string;
        spread?: { awayPct?: number | null; homePct?: number | null };
      };

      // Load ATS per-league files
      const ATS_FILES: Array<[string, string]> = [
        ["nba",   "scraped-ats-nba.json"],
        ["ncaab", "scraped-ats-ncaab.json"],
        ["nhl",   "scraped-ats-nhl.json"],
      ];
      const atsByLeague: Record<string, AtsTeam[]> = {};
      for (const [key, file] of ATS_FILES) {
        const d = loadJson<{ teams: AtsTeam[] }>(path.join(processedDir, file));
        if (d?.teams) atsByLeague[key] = d.teams;
      }

      // Load consensus file
      const cData = loadJson<{ games: CGame[] }>(
        path.join(processedDir, "scraped-consensus.json"),
      );
      const consensusGames: CGame[] = cData?.games ?? [];

      // Team nickname → standard 2-3 letter abbreviation (covers.com format)
      const TEAM_ABBR: Record<string, string> = {
        hawks:"ATL", celtics:"BOS", nets:"BKN", hornets:"CHA", bulls:"CHI",
        cavaliers:"CLE", cavs:"CLE", mavericks:"DAL", mavs:"DAL", nuggets:"DEN",
        pistons:"DET", warriors:"GSW", rockets:"HOU", pacers:"IND", clippers:"LAC",
        lakers:"LAL", grizzlies:"MEM", heat:"MIA", bucks:"MIL", timberwolves:"MIN",
        wolves:"MIN", pelicans:"NOP", knicks:"NYK", thunder:"OKC", magic:"ORL",
        "76ers":"PHI", sixers:"PHI", suns:"PHX", blazers:"POR", kings:"SAC",
        spurs:"SAS", raptors:"TOR", jazz:"UTA", wizards:"WSH",
        // NHL
        bruins:"BOS", avalanche:"COL", lightning:"TBL", leafs:"TOR", oilers:"EDM",
        panthers:"FLA", rangers:"NYR", hurricanes:"CAR", predators:"NSH",
      };

      function teamToAbbr(name: string): string | null {
        const lower = name.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
        for (const [frag, abbr] of Object.entries(TEAM_ABBR)) {
          if (lower.includes(frag)) return abbr;
        }
        return null;
      }

      function atsLeagueKey(league: string): string | null {
        const l = league.toLowerCase();
        if (l.startsWith("nba")) return "nba";
        if (l.startsWith("ncaab") || l.startsWith("ncaa")) return "ncaab";
        if (l.startsWith("nhl")) return "nhl";
        return null;
      }

      for (const bet of betsToEnrich) {
        // ATS enrichment
        const ak = atsLeagueKey(bet.league);
        if (ak && atsByLeague[ak]) {
          const normPick = bet.pickTeam.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
          const pickWords = normPick.split(/\s+/);
          const entry = atsByLeague[ak].find((t) => {
            const normT = t.team.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
            return normT === normPick ||
              pickWords.some((w) => w.length > 3 && normT.includes(w));
          });
          const ov = entry?.overall;
          if (ov && ov.coverPct !== null && ov.coverPct !== undefined) {
            bet.atsRecord = { wins: ov.wins, losses: ov.losses, coverPct: ov.coverPct };
            if (ov.coverPct > 55) {
              bet.confidence = Math.min(
                100,
                bet.confidence + Math.min(3, Math.round(((ov.coverPct - 55) / 5) * 3)),
              );
            } else if (ov.coverPct < 45) {
              bet.confidence = Math.max(
                0,
                bet.confidence - Math.min(3, Math.round(((45 - ov.coverPct) / 5) * 3)),
              );
            }
          }
        }

        // Consensus enrichment
        if (consensusGames.length > 0) {
          const pickAbbr = teamToAbbr(bet.pickTeam);
          const oppAbbr  = teamToAbbr(bet.opponent);
          const cGame = consensusGames.find((g) => {
            const away = g.awayAbbr.toUpperCase();
            const home = g.homeAbbr.toUpperCase();
            const pickOk = pickAbbr
              ? away === pickAbbr || home === pickAbbr
              : g.matchup.toLowerCase().includes(
                  bet.pickTeam.toLowerCase().split(/\s+/).at(-1) ?? "",
                );
            const oppOk = oppAbbr
              ? away === oppAbbr || home === oppAbbr
              : g.matchup.toLowerCase().includes(
                  bet.opponent.toLowerCase().split(/\s+/).at(-1) ?? "",
                );
            return pickOk && oppOk;
          });
          if (cGame?.spread) {
            const sp = cGame.spread;
            const pickIsAway = cGame.awayAbbr.toUpperCase() === (pickAbbr ?? "");
            const pickPct = pickIsAway ? sp.awayPct : sp.homePct;
            const oppPct  = pickIsAway ? sp.homePct  : sp.awayPct;
            if (pickPct != null && oppPct != null) {
              if (pickPct >= 65) {
                bet.publicConsensus = "steam";
                bet.consensusNote = `${Math.round(pickPct)}% public on ${bet.pickTeam} — same as model pick`;
              } else if (oppPct >= 65) {
                bet.publicConsensus = "fade";
                bet.consensusNote = `${Math.round(oppPct)}% public on opponent — potential sharp fade`;
              }
            }
          }
        }
      }

      const enrichedCount = betsToEnrich.filter((b) => b.atsRecord || b.publicConsensus).length;
      if (enrichedCount > 0) {
        console.log(`  [enrich] ${enrichedCount}/${betsToEnrich.length} bets enriched with ATS/consensus data`);
      }
    }
  }
  // ── End enrichment ──────────────────────────────────────────────────────────

  const processedPath = path.join(root, "data", "processed", "latest-summary.json");
  fs.writeFileSync(processedPath, JSON.stringify(summary, null, 2));

  // Write a pre-formatted compact picks file to the betting workspace so the
  // Discord bot can respond instantly (one tiny file read vs full JSON parse).
  try {
    const picksWorkspacePath = path.join(
      process.env.OPENCLAW_WORKSPACE_BETTING ?? "C:\\Users\\nbber\\.openclaw\\workspace-betting",
      "PICKS.md",
    );
    const generatedEt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "numeric", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(summary.generatedAt as string));

    type BetEntry = {
      pickTeam: string; opponent: string; league: string; conference?: string | null;
      spread: number | null; modelSpread: number | null; score: number; confidence: number;
      rationaleSignals?: string[]; gameDate?: string | Date | null;
    };
    const bets = (summary.bestBets as unknown as BetEntry[]) ?? [];
    const fmtGameTime = (d: string | Date | null | undefined): string => {
      if (!d) return "";
      const t = d instanceof Date ? d : new Date(d);
      if (isNaN(t.getTime())) return "";
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric", minute: "2-digit", hour12: true,
      }).format(t) + " ET";
    };
    const leagueCounts: Record<string, number> = {};
    for (const b of bets) leagueCounts[b.league] = (leagueCounts[b.league] ?? 0) + 1;
    const leagueSummary = Object.entries(leagueCounts).map(([l, n]) => `${l}: ${n}`).join(", ");

    const lines: string[] = [
      `# Today's Picks — ${generatedEt} ET`,
      `_${leagueSummary || "No picks today"}_`,
      "",
    ];

    if (bets.length === 0) {
      lines.push("No eligible picks found for today.");
    } else {
      bets.slice(0, 10).forEach((b, i) => {
        const spreadStr = b.spread != null ? ` ${b.spread > 0 ? "+" : ""}${b.spread}` : "";
        const modelStr = b.modelSpread != null && b.spread != null && Math.abs(b.spread - b.modelSpread) >= 3
          ? ` (model: ${b.modelSpread > 0 ? "+" : ""}${b.modelSpread})`
          : "";
        const conf = `${b.league}${b.conference ? `/${b.conference}` : ""}`;
        const gameTime = fmtGameTime(b.gameDate);
        lines.push(`**${i + 1}. ${b.pickTeam}${spreadStr}${modelStr}** vs ${b.opponent} — ${conf}${gameTime ? ` · ${gameTime}` : ""}`);
        lines.push(`Score: ${b.score} | Confidence: ${b.confidence}%`);
        // Surface the 2 most useful signals
        const signals = (b.rationaleSignals ?? []).slice(0, 2);
        if (signals.length) lines.push(`_${signals.join(" · ")}_`);
        lines.push("");
      });
      if (bets.length > 10) lines.push(`_...and ${bets.length - 10} more picks in latest-summary.json_`);
    }

    lines.push(`---`);
    lines.push(`_Run \`npm run ingest:all\` to refresh. Full data: data/processed/latest-summary.json_`);

    fs.writeFileSync(picksWorkspacePath, lines.join("\n"));
    console.log(`Wrote picks to ${picksWorkspacePath}`);

    // Also embed picks into AGENTS.md between <!-- PICKS-START --> and <!-- PICKS-END -->
    // markers so the bot gets them in its system prompt with zero tool calls.
    const agentsPath = path.join(
      process.env.OPENCLAW_WORKSPACE_BETTING ?? "C:\\Users\\nbber\\.openclaw\\workspace-betting",
      "AGENTS.md",
    );
    if (fs.existsSync(agentsPath)) {
      const agentsContent = fs.readFileSync(agentsPath, "utf8");
      const picksBlock = lines.join("\n");
      const updated = agentsContent.replace(
        /<!-- PICKS-START -->[\s\S]*?<!-- PICKS-END -->/,
        `<!-- PICKS-START -->\n${picksBlock}\n<!-- PICKS-END -->`,
      );
      if (updated !== agentsContent) {
        fs.writeFileSync(agentsPath, updated);
        console.log(`Embedded picks into ${agentsPath}`);
      }
    }

    // Clear the betting agent's session JSONL so the next Discord message
    // starts a fresh session with today's picks in the system prompt.
    // Without this, a session started before the ingest would carry yesterday's
    // picks in its baked-in system prompt even after AGENTS.md is updated.
    const sessionsJsonPath = "C:\\Users\\Nate\\.openclaw\\agents\\betting\\sessions\\sessions.json";
    if (fs.existsSync(sessionsJsonPath)) {
      type SessionEntry = { sessionFile?: string; groupChannel?: string; sessionId?: string };
      const sessions = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf8")) as Record<string, SessionEntry>;
      for (const [key, session] of Object.entries(sessions)) {
        if (!key.includes("betting")) continue;
        const sessionFile = session.sessionFile;
        if (sessionFile && fs.existsSync(sessionFile)) {
          fs.writeFileSync(sessionFile, "");
          console.log(`Cleared betting session: ${sessionFile}`);
        }
      }
    }
  } catch (e) {
    console.warn("Could not write picks to betting workspace:", (e as Error).message);
  }

  console.log(`\nIngested ${acceptedRecords.length}/${records.length} free stat rows.`);
  console.log(`  NBA: ${nbaRows.length} (source: ${fetchedNbaRows.length ? "espn-public-api" : "fallback-csv"})`);
  console.log(`  NFL: ${nflRows.length} (source: ${fetchedNflRows.length ? "espn-public-api" : "fallback-json"})`);
  console.log(`  NCAAB: ${ncaabRows.length} (source: ${fetchedNcaabRows.length ? "espn-public-api" : "fallback-csv"})`);
  console.log(`  MLB: ${mlbRows.length} (source: ${fetchedMlbRows.length ? "espn-public-api" : "fallback-csv"})`);
  if (rejectedRecords.length) console.log(`Rejected ${rejectedRecords.length} rows lacking completion evidence.`);
  console.log(`Wrote summary to ${processedPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
