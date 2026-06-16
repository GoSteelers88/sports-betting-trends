// quant-desk/mlb-runner.ts — the MLB desk's one full cycle (impure shell).
//
// Order matters (Armstrong's "worst moment to die" answered): SETTLE first
// (realize P&L + lock CLV on started games), THEN refresh closes on still-open
// pre-game bets, THEN open new plays, THEN snapshot + save. The book write is
// the LAST step and idempotent by bet id, so a crash mid-cycle re-runs cleanly:
// settles re-settle to the same result, opens are deduped by id.

import fs from "node:fs";
import path from "node:path";
import { buildFairValueBoard } from "../fair-value";
import {
  fetchFinalsAround,
  findFinalForMatchup,
  gradeMoneyline,
  type GameFinal,
} from "../espn-finals";
import type { MlbGameLogFile } from "../mlb-prop-distributions";
import { slateTeamsFromEvents, isTeamOnSlate } from "../injuries-scope";
import {
  openFromOpportunities,
  refreshCloses,
  settleBet,
  writeSnapshot,
  computeStats,
  isPlayable,
  QUANT_DESK_CONFIG,
  type QuantStats,
} from "./engine";
import {
  buildMlbMoneylineOpps,
  buildMlbPropOpps,
  buildMoneylineCloseMap,
  type MlbModelFile,
  type SharpPropsFile,
  type SoftPropsFile,
} from "./adapters/mlb";
import { loadBook, saveBook, mlbBookDir } from "./store";
import type { Opportunity, QuantBook } from "./types";

function readJson<T>(dir: string, file: string, def: T): T {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return def;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return def;
  }
}

export interface MlbCycleResult {
  opened: number;
  settled: number;
  refreshedCloses: number;
  oppsScanned: number;
  playable: number;
  railActive: boolean;
  stats: QuantStats;
}

/** Build the full MLB opportunity set (moneyline + props) from disk. Pure-ish:
 *  reads files but no network. Exposed so the report/tests can inspect it. */
export function buildMlbOpportunities(dir: string): {
  opps: Opportunity[];
  closeMap: Map<string, number>;
} {
  const board = buildFairValueBoard("MLB", { dataDir: dir });
  const model = readJson<MlbModelFile>(dir, "mlb-model-output.json", { results: [] });
  const gamelog = readJson<MlbGameLogFile | null>(dir, "player-gamelogs-mlb.json", null);
  const sharpProps = readJson<SharpPropsFile>(dir, "latest-sharp-props-mlb.json", {});
  const softProps = readJson<SoftPropsFile>(dir, "latest-soft-props-mlb.json", {});

  // Slate teams from the MLB odds feed (same gate the prop board uses).
  const oddsFile = readJson<{ events?: Array<{ home_team?: string; away_team?: string }> }>(
    dir,
    "latest-odds-api-baseball_mlb.json",
    { events: [] },
  );
  const slateTeams = slateTeamsFromEvents(oddsFile.events ?? []);
  const isSlateTeam = (team: string | null): boolean => !!team && isTeamOnSlate(team, slateTeams);

  const mlOpps = buildMlbMoneylineOpps(model, board);
  const propOpps = buildMlbPropOpps(gamelog, sharpProps.props ?? [], softProps.quotes ?? [], isSlateTeam);

  return { opps: [...mlOpps, ...propOpps], closeMap: buildMoneylineCloseMap(board) };
}

/** Settle open MONEYLINE bets against ESPN finals. Props are left open + CLV-
 *  tracked (no per-game box-score settler in V1 — documented in the spec). */
async function settleMoneylineBets(book: QuantBook, nowMs: number): Promise<number> {
  const openMl = book.bets.filter(
    (b) => b.status === "open" && b.market === "moneyline",
  );
  if (openMl.length === 0) return 0;
  // Only fetch finals if at least one game has started.
  const started = openMl.filter((b) => {
    const c = new Date(b.commenceTime).getTime();
    return Number.isFinite(c) && nowMs >= c;
  });
  if (started.length === 0) return 0;

  const finals: GameFinal[] = await fetchFinalsAround("MLB", new Date(nowMs));
  let settled = 0;
  for (const bet of started) {
    const commenceMs = new Date(bet.commenceTime).getTime();
    // bet.selection = "<Team> ML" → team is the leading token sequence.
    const team = bet.selection.replace(/\s+ML$/i, "").trim();
    const final = findFinalForMatchup(bet.matchup, team, commenceMs, finals);
    if (!final) continue;
    const result = gradeMoneyline(team, final);
    if (!result) continue;
    settleBet(
      bet,
      result,
      `${final.awayTeam} ${final.awayScore} @ ${final.homeTeam} ${final.homeScore}`,
      nowMs,
    );
    settled++;
  }
  return settled;
}

export async function runMlbQuantCycle(
  opts: { dataDir?: string; nowMs?: number } = {},
): Promise<MlbCycleResult> {
  const dir = opts.dataDir ?? mlbBookDir();
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const book = loadBook(dir, "MLB");

  // 1) settle started moneyline games (realize P&L + lock CLV)
  const settled = await settleMoneylineBets(book, nowMs);

  // 2) build the opportunity set + close map
  const { opps, closeMap } = buildMlbOpportunities(dir);

  // 3) refresh closes on still-open, pre-game bets (CLV close tracking)
  const refreshedCloses = refreshCloses(book, closeMap, nowMs);

  // 4) open new playable bets (drawdown rail handled inside)
  const openRes = openFromOpportunities(book, opps, nowMs);

  // 5) snapshot + persist (LAST — the commit point)
  const stats = writeSnapshot(book, nowIso);
  saveBook(dir, "MLB", book, nowIso);

  const playable = opps.filter((o) => isPlayable(o)).length;

  return {
    opened: openRes.opened,
    settled,
    refreshedCloses,
    oppsScanned: opps.length,
    playable,
    railActive: openRes.railActive,
    stats,
  };
}

/** Read-only report (no cycle, no network) for `quant:mlb report`. */
export function reportMlbQuant(dir: string = mlbBookDir()): {
  stats: QuantStats;
  opps: Opportunity[];
} {
  const book = loadBook(dir, "MLB");
  const { opps } = buildMlbOpportunities(dir);
  return { stats: computeStats(book, QUANT_DESK_CONFIG), opps };
}
