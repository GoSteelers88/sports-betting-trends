// Pure-code cross-run exposure guard. The bankroll guard caps game-line picks
// at one per game WITHIN a run; the @@unique key only blocks a repeat of the
// exact same (league, gameDate, market, selection). Neither stops a later run
// from taking the OTHER side of a game we already hold — measured 2026-10-13:
// NBA Magic -140 (run 10-08) then Hawks +120 (run 10-12) on the same game, and
// Grizzlies +135 then Jazz -134. It also missed a same-side double: Packers
// -195 from a Bovada event at 17:00Z and Packers -194 from a FanDuel event at
// 17:01Z — the one-minute gameDate difference defeated the unique key.
//
// Rule: one game-line (non-prop) position per game across runs. Props are left
// to the bankroll guard's per-run caps (0 cross-run prop conflicts measured).

import type { GradedPick } from "./grader";
import { matchupKey } from "./bankroll";

// Two picks are the same game when their event ids match, or when the teams
// match and start times are this close. The measured split doubleheader
// (Red Sox @ Rays 2026-07-17) started 5.5h apart. A tighter doubleheader would
// lose game 2's pick here — the fail-closed direction, chosen over trusting
// that a feed never re-issues an id for the same game.
const SAME_GAME_WINDOW_MS = 3 * 3600_000;

export type HeldPick = {
  id: number;
  matchup: string;
  market: string;
  selection: string;
  gameDate: Date;
  eventId: string | null;
};

type GameRef = { matchup: string; gameDate: Date | null; eventId: string | null };

// Differing ids prove nothing: the same game arrives as "bv_…" from Bovada and
// "fd_…" from FanDuel, and synthetic "syn:" ids embed a start time that moves.
export function sameGame(a: GameRef, b: GameRef): boolean {
  const ida = a.eventId?.trim();
  const idb = b.eventId?.trim();
  if (ida && idb && ida === idb) return true;
  if (matchupKey(a.matchup) !== matchupKey(b.matchup)) return false;
  if (!a.gameDate || !b.gameDate) return false;
  return Math.abs(a.gameDate.getTime() - b.gameDate.getTime()) <= SAME_GAME_WINDOW_MS;
}

function pickGameDate(p: GradedPick): Date | null {
  if (!p.gameTime) return null;
  const d = new Date(p.gameTime);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function dropHeldGames(
  picks: GradedPick[],
  held: HeldPick[],
): { kept: GradedPick[]; dropped: Array<{ pick: GradedPick; reason: string }> } {
  const heldLines = held.filter(h => h.market !== "prop");
  const kept: GradedPick[] = [];
  const dropped: Array<{ pick: GradedPick; reason: string }> = [];
  for (const p of picks) {
    if (p.market === "prop") {
      kept.push(p);
      continue;
    }
    const ref: GameRef = { matchup: p.matchup, gameDate: pickGameDate(p), eventId: p.eventId ?? null };
    const hit = heldLines.find(h => sameGame(ref, h));
    if (!hit) {
      kept.push(p);
      continue;
    }
    const side = hit.selection.trim().toLowerCase() === p.selection.trim().toLowerCase() ? "same side" : "OPPOSITE side";
    dropped.push({
      pick: p,
      reason: `already hold #${hit.id} "${hit.selection}" on this game (${side}) — one game-line position per game across runs`,
    });
  }
  return { kept, dropped };
}
