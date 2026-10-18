// Pure-code guard: an NBA or WNBA game-line pick must be on a game the model
// actually priced. The grader checks the analyst's arithmetic (edge =
// modelProb − marketProb) but not where modelProb came from, and the critic's
// "did the analyst invent a number?" check is an LLM. Since 2026-10-17 the
// basketball model deliberately leaves games unmodeled (teams under 5 counted
// games, games more than 10 days out, stale ratings), so without this guard
// an unmodeled game could still ship with a modelProb from nowhere.
//
// Scope: NBA + WNBA game lines only. Their model is the only source of a
// game-line modelProb; props come from get_prop_projection, and MLB/NFL have
// their own model paths.

import type { GradedPick } from "./grader";
import { sameGame } from "./held-positions";

const MODEL_GROUNDED_LEAGUES: ReadonlySet<string> = new Set(["NBA", "WNBA"]);

export type ModeledGame = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime?: string | null;
};

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function dropUnmodeledGameLines(
  league: string,
  picks: GradedPick[],
  modeled: ModeledGame[],
): { kept: GradedPick[]; dropped: Array<{ pick: GradedPick; reason: string }> } {
  if (!MODEL_GROUNDED_LEAGUES.has(league)) return { kept: picks, dropped: [] };

  const refs = modeled.map(g => ({
    matchup: `${g.awayTeam} @ ${g.homeTeam}`,
    gameDate: toDate(g.startTime),
    eventId: g.eventId,
  }));
  const kept: GradedPick[] = [];
  const dropped: Array<{ pick: GradedPick; reason: string }> = [];
  for (const p of picks) {
    if (p.market === "prop") {
      kept.push(p);
      continue;
    }
    const ref = { matchup: p.matchup, gameDate: toDate(p.gameTime), eventId: p.eventId ?? null };
    if (refs.some(m => sameGame(ref, m))) {
      kept.push(p);
      continue;
    }
    dropped.push({
      pick: p,
      reason: `no ${league} model probability for this game (unmodeled: too few counted games, beyond the horizon, or stale ratings)`,
    });
  }
  return { kept, dropped };
}
