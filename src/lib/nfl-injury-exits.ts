// nfl-injury-exits.ts — detect players who LEFT A GAME (injury, ejection) from
// snap counts, so grading and learning can tell "played badly" from "was not
// on the field".
//
// 2026 week 2: Jaxson Dart played 12% of NYG snaps (Jameis Winston 88%) and
// Jayden Daniels 55% of WAS snaps (Marcus Mariota 45%) after 100% the week
// before. Both games, and every prop on those players and their receivers,
// were graded and fed to the dream as if the starter played the whole game.
//
// A flagged row still SETTLES normally (books settle a prop once the player has
// taken a snap) - the flag only keeps it out of what the model LEARNS from.

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePlayerName } from "./nfl-loop";

/** First season the loop grades (backtest 2019-2024, holdout 2025, live 2026). */
export const SNAP_FIRST_SEASON = 2019;

export function snapCountsPath(dir: string): string {
  return path.join(dir, "snap_counts.csv");
}

export interface SnapRow {
  gameId: string;
  season: number;
  week: number;
  player: string;
  position: string;
  team: string;
  offenseSnaps: number;
  offensePct: number;
}

/** Thresholds, measured on 2019-2026 snap data (see the calibration notes in
 *  docs/research/2026-08-29-nfl-receipts-preregistration.md, model-input note 1). */
export const EXIT_RULES = {
  /** A QB who ran the offense last game and ceded most of this one to a teammate QB. */
  QB: { priorMin: 0.9, currentMax: 0.6, replacementMin: 0.25 },
  /** RB/WR/TE: a near-every-down player who barely played. */
  SKILL: { priorMin: 0.7, currentMax: 0.3 },
} as const;

const SKILL = new Set(["RB", "WR", "TE"]);

export interface InGameExit {
  gameId: string;
  season: number;
  week: number;
  team: string;
  player: string;
  position: string;
  snapPct: number;
  priorPct: number;
  /** QB exits only: the teammate who took the snaps. */
  replacement?: { player: string; snapPct: number };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseSnapCsv(text: string): SnapRow[] {
  const [h, ...rows] = text.trim().split("\n");
  const H = splitCsv(h);
  const ix = (k: string) => {
    const i = H.indexOf(k);
    if (i < 0) throw new Error(`snap_counts.csv missing column ${k}`);
    return i;
  };
  const [g, s, w, p, pos, t, os, op] = ["game_id", "season", "week", "player", "position", "team", "offense_snaps", "offense_pct"].map(ix);
  return rows.map((r) => {
    const c = splitCsv(r);
    return {
      gameId: c[g], season: Number(c[s]), week: Number(c[w]), player: c[p], position: c[pos],
      team: c[t], offenseSnaps: Number(c[os]), offensePct: Number(c[op]),
    };
  });
}

export function loadSnapCounts(dir: string): SnapRow[] {
  const p = snapCountsPath(dir);
  return fs.existsSync(p) ? parseSnapCsv(fs.readFileSync(p, "utf8")) : [];
}

export interface GameScore { homeTeam: string; awayTeam: string; homeScore: number; awayScore: number }

/**
 * Precision over recall: when a row is ambiguous it stays in the learning set.
 * Guards, each added after it produced a measured false positive on 2019-2026:
 *  - prior game must be the SAME team in the SAME season (Justin Fields, 2026
 *    wk1: "100% -> 1%" was a 2025 NYJ start vs a 2026 KC backup role).
 *  - a QB's replacement must have been a BACKUP (<50% of his own previous
 *    team game), else the "exit" is a returning starter reclaiming the job
 *    (Teddy Bridgewater, 2019 wk8, after Drew Brees came back).
 *  - a team that won by >= 17 pulled its starter to rest him, not lost him.
 */
export function detectInGameExits(rows: SnapRow[], scores?: Map<string, GameScore>): InGameExit[] {
  const ordered = rows
    .filter((r) => r.offenseSnaps > 0)
    .sort((a, b) => a.season - b.season || a.week - b.week);
  const byGameTeam = new Map<string, SnapRow[]>();
  for (const r of ordered) {
    const k = `${r.gameId}|${r.team}`;
    (byGameTeam.get(k) ?? byGameTeam.set(k, []).get(k)!).push(r);
  }
  // player -> offense pct in his previous game for the same team + season
  const prev = new Map<string, number>();
  const pkey = (r: SnapRow) => `${normalizePlayerName(r.player)}|${r.position}|${r.team}|${r.season}`;
  // Snapshot priors per game BEFORE updating, so a teammate's prior is his
  // previous game, not this one.
  const priorOf = new Map<SnapRow, number | undefined>();
  for (const r of ordered) {
    priorOf.set(r, prev.get(pkey(r)));
    prev.set(pkey(r), r.offensePct);
  }
  const wonBy = (r: SnapRow): number | null => {
    const g = scores?.get(r.gameId);
    if (!g) return null;
    const mine = r.team === g.homeTeam ? g.homeScore : g.awayScore;
    const theirs = r.team === g.homeTeam ? g.awayScore : g.homeScore;
    return mine - theirs;
  };

  const exits: InGameExit[] = [];
  for (const r of ordered) {
    const prior = priorOf.get(r);
    if (prior == null) continue;
    const margin = wonBy(r);
    if (margin != null && margin >= 17) continue;

    if (r.position === "QB") {
      const rule = EXIT_RULES.QB;
      if (prior < rule.priorMin || r.offensePct >= rule.currentMax) continue;
      const rep = (byGameTeam.get(`${r.gameId}|${r.team}`) ?? [])
        .filter((m) => m.position === "QB" && m.player !== r.player)
        .sort((a, b) => b.offensePct - a.offensePct)[0];
      if (!rep || rep.offensePct < rule.replacementMin) continue;
      const repPrior = priorOf.get(rep);
      if (repPrior != null && repPrior >= 0.5) continue;
      exits.push({ gameId: r.gameId, season: r.season, week: r.week, team: r.team, player: r.player, position: r.position,
        snapPct: r.offensePct, priorPct: prior, replacement: { player: rep.player, snapPct: rep.offensePct } });
    } else if (SKILL.has(r.position)) {
      const rule = EXIT_RULES.SKILL;
      if (prior < rule.priorMin || r.offensePct >= rule.currentMax) continue;
      exits.push({ gameId: r.gameId, season: r.season, week: r.week, team: r.team, player: r.player, position: r.position,
        snapPct: r.offensePct, priorPct: prior });
    }
  }
  return exits;
}

/** Answers "should the model learn from this row?" for game and prop rows. */
export class ExitIndex {
  private readonly byGame = new Map<string, InGameExit[]>();
  constructor(readonly exits: InGameExit[]) {
    for (const e of exits) (this.byGame.get(e.gameId) ?? this.byGame.set(e.gameId, []).get(e.gameId)!).push(e);
  }

  /** A game result is affected when EITHER team's QB left the game. */
  gameExits(gameId: string): InGameExit[] {
    return (this.byGame.get(gameId) ?? []).filter((e) => e.position === "QB");
  }

  /** A prop is affected when the player left, or his team's QB left (his
   *  targets/volume came from a different passer - Malik Nabers, 1 yard, wk2). */
  propExits(gameId: string, player: string, team: string): InGameExit[] {
    const name = normalizePlayerName(player);
    return (this.byGame.get(gameId) ?? []).filter(
      (e) => normalizePlayerName(e.player) === name || (e.position === "QB" && (!team || e.team === team)),
    );
  }
}

/** Final scores from the loop's games.csv (nflverse schedule), for the rest guard. */
export function loadGameScores(dir: string): Map<string, GameScore> {
  const p = path.join(dir, "games.csv");
  const out = new Map<string, GameScore>();
  if (!fs.existsSync(p)) return out;
  const [h, ...rows] = fs.readFileSync(p, "utf8").trim().split("\n");
  const H = splitCsv(h);
  const ix = (k: string) => H.indexOf(k);
  for (const line of rows) {
    const c = splitCsv(line);
    if (c[ix("home_score")] === "" || c[ix("away_score")] === "") continue;
    out.set(c[ix("game_id")], {
      homeTeam: c[ix("home_team")], awayTeam: c[ix("away_team")],
      homeScore: Number(c[ix("home_score")]), awayScore: Number(c[ix("away_score")]),
    });
  }
  return out;
}

export function loadExitIndex(dir: string): ExitIndex {
  return new ExitIndex(detectInGameExits(loadSnapCounts(dir), loadGameScores(dir)));
}

/** Split rows into what the model may learn from and what it may not. */
export function partitionByExit<T>(rows: T[], affected: (r: T) => InGameExit[]): { kept: T[]; excluded: T[] } {
  const kept: T[] = [], excluded: T[] = [];
  for (const r of rows) (affected(r).length ? excluded : kept).push(r);
  return { kept, excluded };
}
