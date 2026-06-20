// Unit tests for the by-stat plays assembler: line→threshold mapping, the
// model-first board (model prob prints with no market), the market overlay
// (edge + best price + playable), and clean degradation to empty.

import { describe, it, expect } from "vitest";
import {
  buildMlbPropPlays,
  lineToThreshold,
  samePlayer,
  type SharpPropRow,
  type SoftQuoteRow,
} from "../mlb-prop-plays";
import type { MlbGameLogFile, PlayerGameLog } from "../mlb-prop-distributions";

const LEAGUE_AVERAGES = {
  batter_hits: 1.067,
  batter_home_runs: 0.133,
  batter_rbis: 0.382,
  batter_runs_scored: 0.571,
  pitcher_strikeouts: 1.117,
  pitcher_earned_runs: 0.933,
};

function player(name: string, team: string, stat: string, values: number[]): PlayerGameLog {
  return {
    displayName: name,
    team,
    games: [...values].reverse().map((v, i) => ({
      date: `2026-05-${String(20 - i).padStart(2, "0")}T22:00Z`,
      opponent: "Opp",
      stats: { [stat]: v },
    })),
  };
}

function fileWith(players: PlayerGameLog[]): MlbGameLogFile {
  return {
    generatedAt: new Date().toISOString(),
    league: "MLB",
    leagueAverages: LEAGUE_AVERAGES,
    players: Object.fromEntries(
      players.map(p => [
        p.displayName.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim(),
        p,
      ]),
    ),
  };
}

describe("lineToThreshold", () => {
  it("maps a .5 line to the integer rung above it", () => {
    expect(lineToThreshold(0.5)).toBe(1);
    expect(lineToThreshold(1.5)).toBe(2);
    expect(lineToThreshold(3.5)).toBe(4);
  });
  it("rejects whole-number lines (not a milestone rung)", () => {
    expect(lineToThreshold(2)).toBeNull();
    expect(lineToThreshold(0)).toBeNull();
  });
});

describe("samePlayer", () => {
  it("matches exact and last-name + first-initial", () => {
    expect(samePlayer("Aaron Judge", "Aaron Judge")).toBe(true);
    expect(samePlayer("A. Judge", "Aaron Judge")).toBe(true);
    expect(samePlayer("Aaron Judge", "Mike Trout")).toBe(false);
  });
});

describe("buildMlbPropPlays — degradation", () => {
  it("returns an empty board with no gamelog", () => {
    const board = buildMlbPropPlays({ gamelog: null, isSlateTeam: () => true, sharp: [], soft: [] });
    expect(board.groups).toEqual([]);
    expect(board.totalPlayers).toBe(0);
  });
  it("returns an empty board when no players are on the slate", () => {
    const file = fileWith([player("Aaron Judge", "New York Yankees", "batter_hits", [1, 2, 1, 0, 2, 1])]);
    const board = buildMlbPropPlays({ gamelog: file, isSlateTeam: () => false, sharp: [], soft: [] });
    expect(board.groups).toEqual([]);
  });
});

describe("buildMlbPropPlays — model-first ladders", () => {
  const file = fileWith([
    player("Aaron Judge", "New York Yankees", "batter_hits", [1, 2, 1, 0, 2, 1, 3, 1]),
  ]);

  it("prints model probabilities for every rung even with NO market", () => {
    const board = buildMlbPropPlays({ gamelog: file, isSlateTeam: () => true, sharp: [], soft: [] });
    const hits = board.groups.find(g => g.stat === "batter_hits")!;
    expect(hits).toBeTruthy();
    const ladder = hits.ladders[0];
    expect(ladder.rungs).toHaveLength(4); // 1+,2+,3+,4+
    for (const r of ladder.rungs) {
      expect(r.modelProb).toBeGreaterThan(0);
      expect(r.modelProb).toBeLessThan(1);
      expect(r.marketProb).toBeNull(); // no overlay
      expect(r.edge).toBeNull();
    }
    // monotone across rungs
    for (let i = 1; i < ladder.rungs.length; i++) {
      expect(ladder.rungs[i].modelProb).toBeLessThanOrEqual(ladder.rungs[i - 1].modelProb);
    }
  });
});

describe("buildMlbPropPlays — market overlay", () => {
  // A pitcher with a strong K rate, plus a sharp + soft K line at 4.5 (rung 5+).
  const file = fileWith([
    player("Tarik Skubal", "Detroit Tigers", "pitcher_strikeouts", [7, 8, 6, 9, 7, 8, 7, 9]),
  ]);

  const sharp: SharpPropRow[] = [
    {
      player: "Tarik Skubal",
      units: "Strikeouts",
      line: 4.5,
      overAmerican: -200,
      underAmerican: 160,
      fairOverProb: 0.62, // de-vigged sharp P(≥5)
    },
  ];
  const soft: SoftQuoteRow[] = [
    { player: "Tarik Skubal", market: "pitcher_strikeouts", line: 4.5, side: "Over", american: 120, book: "fanduel" },
    { player: "Tarik Skubal", market: "pitcher_strikeouts", line: 4.5, side: "Over", american: -110, book: "bovada" },
  ];

  it("overlays market prob + edge + best price on the matching rung", () => {
    const board = buildMlbPropPlays({ gamelog: file, isSlateTeam: () => true, sharp, soft });
    const k = board.groups.find(g => g.stat === "pitcher_strikeouts")!;
    const ladder = k.ladders[0];
    // The 5+ rung corresponds to line 4.5.
    const rung5 = ladder.rungs.find(r => r.threshold === 5)!;
    expect(rung5.marketProb).toBeCloseTo(0.62, 4);
    expect(rung5.edge).toBeCloseTo(rung5.modelProb - 0.62, 4);
    // best soft over = the more positive American (+120 @ fanduel)
    expect(rung5.bestPrice).toBe(120);
    expect(rung5.bestBook).toBe("fanduel");
    expect(rung5.evPct).not.toBeNull();
    // rungs without a market line stay model-only
    const rung4 = ladder.rungs.find(r => r.threshold === 4);
    expect(rung4?.marketProb).toBeNull();
  });

  it("flags playable when model EV clears the floor and beats the sharp line", () => {
    // Skubal model P(≥5) is high; at +120 EV is comfortably positive and the
    // model should beat a 0.40 sharp line.
    const weakSharp: SharpPropRow[] = [{ ...sharp[0], fairOverProb: 0.4 }];
    const board = buildMlbPropPlays({ gamelog: file, isSlateTeam: () => true, sharp: weakSharp, soft });
    const ladder = board.groups.find(g => g.stat === "pitcher_strikeouts")!.ladders[0];
    const rung5 = ladder.rungs.find(r => r.threshold === 5)!;
    expect(rung5.edge! > 0).toBe(true);
    expect(rung5.playable).toBe(true);
    expect(ladder.hasPlayable).toBe(true);
  });

  it("does NOT flag playable when the sharp line says the model is wrong", () => {
    // Sharp insists P(≥5)=0.97 (higher than our model) → negative edge → not
    // playable even if the soft price looks juicy.
    const richSharp: SharpPropRow[] = [{ ...sharp[0], fairOverProb: 0.97 }];
    const board = buildMlbPropPlays({ gamelog: file, isSlateTeam: () => true, sharp: richSharp, soft });
    const ladder = board.groups.find(g => g.stat === "pitcher_strikeouts")!.ladders[0];
    const rung5 = ladder.rungs.find(r => r.threshold === 5)!;
    expect(rung5.edge! < 0).toBe(true);
    expect(rung5.playable).toBe(false);
  });
});

describe("buildMlbPropPlays — probable-starter gate", () => {
  // Two pitchers whose teams are both on the slate and both have K game-logs,
  // plus a hitter. Only Skubal is starting tonight. Without the gate, Warren's
  // phantom K ladder surfaces off stale logs even though he isn't pitching.
  const file = fileWith([
    player("Will Warren", "New York Yankees", "pitcher_strikeouts", [5, 6, 4, 7, 5, 6, 5, 6]),
    player("Tarik Skubal", "Detroit Tigers", "pitcher_strikeouts", [7, 8, 6, 9, 7, 8, 7, 9]),
    player("Aaron Judge", "New York Yankees", "batter_hits", [1, 2, 1, 0, 2, 1, 3, 1]),
  ]);

  const pitcherNames = (board: ReturnType<typeof buildMlbPropPlays>): string[] =>
    (board.groups.find(g => g.stat === "pitcher_strikeouts")?.ladders ?? []).map(l => l.player);

  it("drops a pitcher who isn't a probable starter, keeps the one who is", () => {
    const board = buildMlbPropPlays({
      gamelog: file, isSlateTeam: () => true, sharp: [], soft: [],
      probableStarters: ["Tarik Skubal"],
    });
    const names = pitcherNames(board);
    expect(names).toContain("Tarik Skubal");
    expect(names).not.toContain("Will Warren"); // the bug this fixes
  });

  it("matches starters fuzzily (last name + first initial)", () => {
    const board = buildMlbPropPlays({
      gamelog: file, isSlateTeam: () => true, sharp: [], soft: [],
      probableStarters: ["W. Warren"],
    });
    expect(pitcherNames(board)).toContain("Will Warren");
  });

  it("does NOT gate batter stats — a hitter shows regardless of the starter list", () => {
    const board = buildMlbPropPlays({
      gamelog: file, isSlateTeam: () => true, sharp: [], soft: [],
      probableStarters: ["Tarik Skubal"],
    });
    const hitters = board.groups.find(g => g.stat === "batter_hits")?.ladders.map(l => l.player) ?? [];
    expect(hitters).toContain("Aaron Judge");
  });

  it("an empty starter list yields no pitcher ladders (no confirmed starters)", () => {
    const board = buildMlbPropPlays({
      gamelog: file, isSlateTeam: () => true, sharp: [], soft: [],
      probableStarters: [],
    });
    expect(board.groups.find(g => g.stat === "pitcher_strikeouts")).toBeUndefined();
  });

  it("undefined starter list disables the gate (back-compat)", () => {
    const board = buildMlbPropPlays({ gamelog: file, isSlateTeam: () => true, sharp: [], soft: [] });
    expect(pitcherNames(board)).toContain("Will Warren");
  });
});
