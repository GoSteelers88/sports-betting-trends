// Which ESPN games count toward ratings and game logs.
//
// ESPN scoreboard events carry season.type:
//   1 preseason · 2 regular season · 3 postseason · 4 off-season · 5 play-in
// A `dates=` scoreboard query returns every type, so anything that rates how a
// team or player plays NOW has to filter. Preseason is starters resting and
// end-of-bench minutes. Measured 2026-10-17 by replaying the NBA efficiency
// model over 2023-24 … 2025-26: on games where teams had < 3 real games, the
// preseason-fed ratings scored WORSE than always picking the home team (Brier
// +0.029 ± 0.013, n=144). The 2026-27 opener ran on 67 preseason games and
// nothing else.
//
// An event with no season type fails closed (not countable): a missing field
// should darken the model, not slip exhibition games back in.

export const COUNTABLE_SEASON_TYPES: ReadonlySet<number> = new Set([2, 3, 5]);

export type EspnSeasonRef = { season?: { type?: number; year?: number } };

export function isCountableEspnEvent(event: EspnSeasonRef): boolean {
  const type = event.season?.type;
  return typeof type === "number" && COUNTABLE_SEASON_TYPES.has(type);
}

/** ESPN's season.year names a season by the year it ENDS in: NBA 2027 = "2026-27". */
export function nbaSeasonLabel(year: number): string {
  return `${year - 1}-${String(year % 100).padStart(2, "0")}`;
}
