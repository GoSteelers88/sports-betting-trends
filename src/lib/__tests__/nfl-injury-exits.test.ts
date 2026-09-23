// In-game exit detection from snap counts. Positives are the real 2026 week 2
// cases; every negative is a false positive the first version of the rule
// actually produced on 2019-2026 data.
import { describe, it, expect } from "vitest";
import { detectInGameExits, ExitIndex, partitionByExit, type SnapRow, type GameScore } from "../nfl-injury-exits";

const row = (o: Partial<SnapRow> & Pick<SnapRow, "gameId" | "season" | "week" | "player" | "team" | "offensePct">): SnapRow => ({
  position: "QB", offenseSnaps: Math.round(o.offensePct * 60) || 1, ...o,
});
const score = (home: string, away: string, hs: number, as: number): GameScore => ({ homeTeam: home, awayTeam: away, homeScore: hs, awayScore: as });

describe("detectInGameExits", () => {
  it("flags Jaxson Dart, 2026 wk2: 100% -> 12%, Jameis Winston (backup) took 88%", () => {
    const rows = [
      row({ gameId: "2026_01_DAL_NYG", season: 2026, week: 1, player: "Jaxson Dart", team: "NYG", offensePct: 1 }),
      row({ gameId: "2026_02_NYG_LA", season: 2026, week: 2, player: "Jaxson Dart", team: "NYG", offensePct: 0.12 }),
      row({ gameId: "2026_02_NYG_LA", season: 2026, week: 2, player: "Jameis Winston", team: "NYG", offensePct: 0.88 }),
    ];
    const exits = detectInGameExits(rows, new Map([["2026_02_NYG_LA", score("LA", "NYG", 28, 6)]]));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ player: "Jaxson Dart", replacement: { player: "Jameis Winston" } });
  });

  it("negative: a prior start for ANOTHER team is not a baseline (Justin Fields, NYJ 2025 -> KC backup 2026)", () => {
    const rows = [
      row({ gameId: "2025_18_NYJ_BUF", season: 2025, week: 18, player: "Justin Fields", team: "NYJ", offensePct: 1 }),
      row({ gameId: "2026_01_DEN_KC", season: 2026, week: 1, player: "Justin Fields", team: "KC", offensePct: 0.01 }),
      row({ gameId: "2026_01_DEN_KC", season: 2026, week: 1, player: "Patrick Mahomes", team: "KC", offensePct: 1 }),
    ];
    expect(detectInGameExits(rows)).toEqual([]);
  });

  it("negative: a returning starter reclaiming the job is not an exit (Bridgewater after Brees, 2019)", () => {
    const rows = [
      row({ gameId: "g1", season: 2019, week: 1, player: "Drew Brees", team: "NO", offensePct: 1 }),
      row({ gameId: "g7", season: 2019, week: 7, player: "Teddy Bridgewater", team: "NO", offensePct: 1 }),
      row({ gameId: "g8", season: 2019, week: 8, player: "Teddy Bridgewater", team: "NO", offensePct: 0.07 }),
      row({ gameId: "g8", season: 2019, week: 8, player: "Drew Brees", team: "NO", offensePct: 0.93 }),
    ];
    expect(detectInGameExits(rows)).toEqual([]);
  });

  it("negative: a team that won by 17+ rested its starter", () => {
    const rows = [
      row({ gameId: "a", season: 2024, week: 1, player: "Starter", team: "KC", offensePct: 1 }),
      row({ gameId: "b", season: 2024, week: 2, player: "Starter", team: "KC", offensePct: 0.55 }),
      row({ gameId: "b", season: 2024, week: 2, player: "Backup", team: "KC", offensePct: 0.45 }),
    ];
    expect(detectInGameExits(rows, new Map([["b", score("KC", "DEN", 41, 10)]]))).toEqual([]);
    // same snaps, close game -> it IS an exit (control for the guard above)
    expect(detectInGameExits(rows, new Map([["b", score("KC", "DEN", 20, 17)]]))).toHaveLength(1);
  });

  it("negative: a low-snap QB with no teammate taking over is not flagged", () => {
    const rows = [
      row({ gameId: "a", season: 2024, week: 1, player: "Starter", team: "KC", offensePct: 1 }),
      row({ gameId: "b", season: 2024, week: 2, player: "Starter", team: "KC", offensePct: 0.5 }),
    ];
    expect(detectInGameExits(rows)).toEqual([]);
  });

  it("flags a skill player who went from every-down to barely playing (Saquon Barkley 71% -> 16%)", () => {
    const rows = [
      row({ gameId: "a", season: 2026, week: 1, player: "Saquon Barkley", team: "PHI", position: "RB", offensePct: 0.71 }),
      row({ gameId: "b", season: 2026, week: 2, player: "Saquon Barkley", team: "PHI", position: "RB", offensePct: 0.16 }),
    ];
    expect(detectInGameExits(rows)).toMatchObject([{ player: "Saquon Barkley", position: "RB" }]);
  });
});

describe("ExitIndex", () => {
  const idx = new ExitIndex([
    { gameId: "2026_02_NYG_LA", season: 2026, week: 2, team: "NYG", player: "Jaxson Dart", position: "QB", snapPct: 0.12, priorPct: 1 },
  ]);
  it("a QB exit affects the game and his team's props, not the opponent's", () => {
    expect(idx.gameExits("2026_02_NYG_LA")).toHaveLength(1);
    expect(idx.propExits("2026_02_NYG_LA", "Malik Nabers", "NYG")).toHaveLength(1);
    expect(idx.propExits("2026_02_NYG_LA", "Puka Nacua", "LA")).toHaveLength(0);
    expect(idx.gameExits("2026_02_DET_BUF")).toHaveLength(0);
  });
  it("partitionByExit keeps unaffected rows and never drops a row silently", () => {
    const rows = [{ gameId: "2026_02_NYG_LA" }, { gameId: "2026_02_DET_BUF" }];
    const { kept, excluded } = partitionByExit(rows, (r) => idx.gameExits(r.gameId));
    expect(kept).toEqual([{ gameId: "2026_02_DET_BUF" }]);
    expect(excluded).toEqual([{ gameId: "2026_02_NYG_LA" }]);
  });
});
