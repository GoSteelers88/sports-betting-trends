// nfl-props-public.ts — project the private weekly prop capture into the
// committed public receipt the site can actually read.
//
// The capture and its graded log both live under data/private/ (gitignored),
// so without this step nothing about the prop market reaches the built page.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  summarizeProps,
  type PublicPropBoard,
  type PublicPropLine,
  type PropSide,
  type PropOutcome,
} from "./nfl-receipts/prop-board";
import { loadLivePropRows } from "./nfl-props-live-store";

export function publicPropBoardPath(season: number, week: number): string {
  const wk = String(week).padStart(2, "0");
  return path.join(process.cwd(), "data", "processed", "nfl-live", `props-${season}-wk${wk}.json`);
}

/** Fields nfl:props-picks writes into the public board; a re-grade must keep them. */
export const PICK_FIELDS = ["picks", "rawViews", "picksGeneratedAt", "pickFloors"] as const;

/** Build + write the public receipt for one week. Returns null when the private
 *  capture for that week does not exist. */
export function writePublicPropBoard(
  privateDir: string,
  season: number,
  week: number,
): PublicPropBoard | null {
  const capturePath = path.join(privateDir, "live-props", `${season}-REG-wk${week}.json`);
  if (!fs.existsSync(capturePath)) return null;

  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
    generatedAt: string;
    games: number;
    rows: Array<{
      gameId: string; matchup: string; player: string; team: string; position: string;
      stat: string; side: PropSide; point: number; priceAmerican: number; book: string; booksOffering: number;
    }>;
  };

  // Graded rows are keyed gameId|player|stat|side (the side suffix is what stops
  // an under overwriting its over — see nfl-props-grade).
  const graded = new Map(
    loadLivePropRows(privateDir).map((r) => [r.key, r]),
  );

  const lines: PublicPropLine[] = capture.rows.map((r) => {
    const g = graded.get(`${r.gameId}|${r.player}|${r.stat}|${r.side}`);
    return {
      gameId: r.gameId,
      matchup: r.matchup,
      player: r.player,
      team: r.team,
      stat: r.stat,
      side: r.side,
      point: r.point,
      priceAmerican: r.priceAmerican,
      book: r.book,
      booksOffering: r.booksOffering,
      // An ungraded line is PENDING, never a loss. "no-data" is preserved
      // distinctly: it means the box score had no row for that player, which
      // is a data gap, not a result.
      result: (g ? (g.result as PropOutcome) : "pending"),
      actualValue: g ? g.actualValue : null,
    };
  });

  // "no-data" means the grader found no box-score row. BEFORE a week is played
  // that is simply every line, and publishing it as "no-data" tells a reader
  // something is broken when the games just have not kicked off. If NOTHING in
  // the week has an actual value yet, the week is ungraded — call those PENDING.
  // Once any line has a real value, a remaining "no-data" is a genuine gap
  // (a player who did not record a stat line) and keeps its name.
  const weekHasAnyActual = lines.some((l) => l.actualValue != null);
  if (!weekHasAnyActual) {
    for (const l of lines) if (l.result === "no-data") l.result = "pending";
  }

  const { byStat, totals } = summarizeProps(lines);
  const board: PublicPropBoard = {
    season,
    week,
    capturedAt: capture.generatedAt,
    gradedAt: lines.some((l) => l.result !== "pending") ? new Date().toISOString() : null,
    games: capture.games,
    lines,
    byStat,
    totals,
  };

  const out = publicPropBoardPath(season, week);
  // nfl:props-picks adds the model's picks to this same file AFTER capture.
  // Re-grading rebuilds the board from the capture, so carry those fields
  // over or every re-grade silently deletes a published receipt - which is
  // what happened to week 2's 20 picks on 2026-09-23.
  const carried: Record<string, unknown> = {};
  if (fs.existsSync(out)) {
    const prev = JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, unknown>;
    for (const k of PICK_FIELDS) if (prev[k] !== undefined) carried[k] = prev[k];
  }
  const written = { ...board, ...carried } as PublicPropBoard;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(written, null, 2) + "\n");
  return written;
}
