// Unit tests for the DISK SHELL (loadMlbPropPlays in mlb-prop-plays-loader.ts).
//
// These write fixture JSON to a temp `dir` and inject `nowMs`, so they exercise
// the real disk read + freshness gates + slate scoping deterministically —
// without touching data/processed. The pure core (buildMlbPropPlays) is tested
// separately in mlb-prop-plays.test.ts; here we prove the SHELL wires it right:
//   - fresh gamelog + STALE market feed → model-only ladders (no market overlay),
//   - a stale gamelog → empty + stale flag,
//   - a missing gamelog → empty board,
//   - the market overlay appears only when the market feed is FRESH.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMlbPropPlays, loadMlbPropSlateStatus } from "../mlb-prop-plays-loader";
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

function gamelogFile(generatedAt: string, players: PlayerGameLog[]): MlbGameLogFile {
  return {
    generatedAt,
    league: "MLB",
    leagueAverages: LEAGUE_AVERAGES,
    players: Object.fromEntries(
      players.map((p) => [
        p.displayName.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim(),
        p,
      ]),
    ),
  };
}

// A minimal MLB odds feed putting the two given franchises on the slate.
function oddsFile(commence: string, home: string, away: string) {
  return { events: [{ id: "e1", commence_time: commence, home_team: home, away_team: away }] };
}

const NOW = Date.parse("2026-05-21T18:00:00Z");
const FRESH_STAMP = "2026-05-21T12:00:00Z"; // 6h before NOW → fresh for all budgets
const STALE_STAMP = "2026-04-01T00:00:00Z"; // weeks before NOW → stale

let dir: string;

function write(file: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data), "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-prop-loader-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadMlbPropPlays — disk shell", () => {
  it("fresh gamelog + a STALE market feed → model-only ladders (overlay dropped)", () => {
    write(
      "player-gamelogs-mlb.json",
      gamelogFile(FRESH_STAMP, [
        player("Aaron Judge", "New York Yankees", "batter_home_runs", [1, 0, 1, 1, 0, 2, 1, 0]),
      ]),
    );
    write("latest-odds-api-baseball_mlb.json", oddsFile(
      "2026-05-21T23:05:00Z", "New York Yankees", "Boston Red Sox",
    ));
    // A market feed whose fetchedAt is weeks old: the freshness gate must DROP it,
    // so no rung gets a marketProb/edge overlay even though the rows "exist".
    write("latest-sharp-props-mlb.json", {
      fetchedAt: STALE_STAMP,
      props: [
        { player: "Aaron Judge", units: "HomeRuns", line: 0.5, overAmerican: 150, underAmerican: -180, fairOverProb: 0.45 },
      ],
    });
    write("latest-soft-props-mlb.json", {
      fetchedAt: STALE_STAMP,
      quotes: [
        { player: "Aaron Judge", market: "batter_home_runs", line: 0.5, side: "Over", american: 170, book: "fanduel" },
      ],
    });

    const board = loadMlbPropPlays({ dir, nowMs: NOW });
    expect(board.stale).toBe(false);
    expect(board.groups.length).toBeGreaterThan(0);
    const hr = board.groups.find((g) => g.stat === "batter_home_runs");
    expect(hr).toBeTruthy();
    // Model ladder is present…
    const ladder = hr!.ladders[0];
    expect(ladder.rungs[0].modelProb).toBeGreaterThan(0);
    // …but the STALE market overlay was dropped: no marketProb/edge/price anywhere.
    for (const r of ladder.rungs) {
      expect(r.marketProb).toBeNull();
      expect(r.edge).toBeNull();
      expect(r.bestPrice).toBeNull();
      expect(r.playable).toBe(false);
    }
  });

  it("fresh gamelog + a FRESH market feed → the overlay is applied", () => {
    write(
      "player-gamelogs-mlb.json",
      gamelogFile(FRESH_STAMP, [
        player("Aaron Judge", "New York Yankees", "batter_home_runs", [1, 0, 1, 1, 0, 2, 1, 0]),
      ]),
    );
    write("latest-odds-api-baseball_mlb.json", oddsFile(
      "2026-05-21T23:05:00Z", "New York Yankees", "Boston Red Sox",
    ));
    write("latest-sharp-props-mlb.json", {
      fetchedAt: FRESH_STAMP,
      props: [
        { player: "Aaron Judge", units: "HomeRuns", line: 0.5, overAmerican: 150, underAmerican: -180, fairOverProb: 0.35 },
      ],
    });
    write("latest-soft-props-mlb.json", {
      fetchedAt: FRESH_STAMP,
      quotes: [
        { player: "Aaron Judge", market: "batter_home_runs", line: 0.5, side: "Over", american: 170, book: "fanduel" },
      ],
    });

    const board = loadMlbPropPlays({ dir, nowMs: NOW });
    const hr = board.groups.find((g) => g.stat === "batter_home_runs")!;
    const rung1 = hr.ladders[0].rungs.find((r) => r.threshold === 1)!;
    // The fresh line mapped onto the 1+ rung → overlay present.
    expect(rung1.marketProb).toBeCloseTo(0.35, 4);
    expect(rung1.edge).not.toBeNull();
    expect(rung1.bestPrice).toBe(170);
    expect(rung1.bestBook).toBe("fanduel");
  });

  it("a STALE gamelog → empty board + stale flag + preserved provenance", () => {
    write(
      "player-gamelogs-mlb.json",
      gamelogFile(STALE_STAMP, [
        player("Aaron Judge", "New York Yankees", "batter_home_runs", [1, 0, 1, 1, 0, 2, 1, 0]),
      ]),
    );
    write("latest-odds-api-baseball_mlb.json", oddsFile(
      "2026-05-21T23:05:00Z", "New York Yankees", "Boston Red Sox",
    ));

    const board = loadMlbPropPlays({ dir, nowMs: NOW });
    expect(board.stale).toBe(true);
    expect(board.groups).toEqual([]);
    expect(board.totalPlayers).toBe(0);
    expect(board.generatedAt).toBe(STALE_STAMP);
  });

  it("a MISSING gamelog → empty board (no throw)", () => {
    // Only the odds file exists; no gamelog on disk.
    write("latest-odds-api-baseball_mlb.json", oddsFile(
      "2026-05-21T23:05:00Z", "New York Yankees", "Boston Red Sox",
    ));
    const board = loadMlbPropPlays({ dir, nowMs: NOW });
    expect(board.groups).toEqual([]);
    expect(board.totalPlayers).toBe(0);
    expect(board.stale).toBe(false);
  });

  it("empties when no slate team matches the gamelog players", () => {
    write(
      "player-gamelogs-mlb.json",
      gamelogFile(FRESH_STAMP, [
        player("Aaron Judge", "New York Yankees", "batter_home_runs", [1, 0, 1, 1, 0, 2, 1, 0]),
      ]),
    );
    // Slate is two OTHER teams → Judge (Yankees) is off-slate → no ladders.
    write("latest-odds-api-baseball_mlb.json", oddsFile(
      "2026-05-21T23:05:00Z", "Los Angeles Dodgers", "San Diego Padres",
    ));
    const board = loadMlbPropPlays({ dir, nowMs: NOW });
    expect(board.groups).toEqual([]);
  });

  it("PHANTOM-JOIN analog: fresh sharp × STALE soft → the STALE soft side is dropped (no soft overlay)", () => {
    // Per-side gating: the sharp file is fresh, the soft file is stale. The stale
    // soft side must be dropped so no bestPrice/bestBook (soft-derived) leaks onto
    // a rung priced against yesterday's soft quotes — the loader-level version of
    // the props-board phantom-join guard.
    write(
      "player-gamelogs-mlb.json",
      gamelogFile(FRESH_STAMP, [
        player("Aaron Judge", "New York Yankees", "batter_home_runs", [1, 0, 1, 1, 0, 2, 1, 0]),
      ]),
    );
    write("latest-odds-api-baseball_mlb.json", oddsFile(
      "2026-05-21T23:05:00Z", "New York Yankees", "Boston Red Sox",
    ));
    write("latest-sharp-props-mlb.json", {
      fetchedAt: FRESH_STAMP,
      props: [
        { player: "Aaron Judge", units: "HomeRuns", line: 0.5, overAmerican: 150, underAmerican: -180, fairOverProb: 0.35 },
      ],
    });
    // Soft feed is weeks stale → dropped by the freshness gate.
    write("latest-soft-props-mlb.json", {
      fetchedAt: STALE_STAMP,
      quotes: [
        { player: "Aaron Judge", market: "batter_home_runs", line: 0.5, side: "Over", american: 170, book: "fanduel" },
      ],
    });

    const board = loadMlbPropPlays({ dir, nowMs: NOW });
    const hr = board.groups.find((g) => g.stat === "batter_home_runs")!;
    const rung1 = hr.ladders[0].rungs.find((r) => r.threshold === 1)!;
    // Sharp side is fresh → its marketProb overlay is present…
    expect(rung1.marketProb).toBeCloseTo(0.35, 4);
    // …but the STALE soft side was dropped → no soft price/book, no EV, not playable.
    expect(rung1.bestPrice).toBeNull();
    expect(rung1.bestBook).toBeNull();
    expect(rung1.evPct).toBeNull();
    expect(rung1.playable).toBe(false);
  });
});

describe("loadMlbPropSlateStatus — chat commence/odds gate", () => {
  // Odds file WITH a fetchedAt (the slate-status freshness gate reads it).
  function oddsWithStamp(fetchedAt: string, commence: string) {
    return {
      fetchedAt,
      events: [
        { id: "e1", commence_time: commence, home_team: "New York Yankees", away_team: "Boston Red Sox" },
      ],
    };
  }

  it("fresh odds + an upcoming game → oddsFresh:true, hasUpcomingGame:true", () => {
    write("latest-odds-api-baseball_mlb.json", oddsWithStamp(FRESH_STAMP, "2026-05-21T23:05:00Z"));
    const s = loadMlbPropSlateStatus({ dir, nowMs: NOW });
    expect(s.oddsFresh).toBe(true);
    expect(s.hasUpcomingGame).toBe(true);
    expect(s.newestCommenceMs).toBe(Date.parse("2026-05-21T23:05:00Z"));
  });

  it("fresh odds but every game already started → hasUpcomingGame:false", () => {
    // Commence is BEFORE NOW (game already started) though the odds file is fresh.
    write("latest-odds-api-baseball_mlb.json", oddsWithStamp(FRESH_STAMP, "2026-05-21T16:00:00Z"));
    const s = loadMlbPropSlateStatus({ dir, nowMs: NOW });
    expect(s.oddsFresh).toBe(true);
    expect(s.hasUpcomingGame).toBe(false);
  });

  it("stale odds snapshot → oddsFresh:false", () => {
    write("latest-odds-api-baseball_mlb.json", oddsWithStamp(STALE_STAMP, "2026-05-21T23:05:00Z"));
    const s = loadMlbPropSlateStatus({ dir, nowMs: NOW });
    expect(s.oddsFresh).toBe(false);
  });

  it("missing odds file → oddsFresh:false, no upcoming game (no throw)", () => {
    const s = loadMlbPropSlateStatus({ dir, nowMs: NOW });
    expect(s.oddsFresh).toBe(false);
    expect(s.hasUpcomingGame).toBe(false);
    expect(s.newestCommenceMs).toBe(-Infinity);
  });
});
