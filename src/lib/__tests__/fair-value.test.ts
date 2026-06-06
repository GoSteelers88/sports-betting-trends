// Unit tests for the fair-value / +EV engine. Uses hand-built fixtures so the
// EV math and team-matching are pinned independent of live feeds.

import { describe, it, expect } from "vitest";
import {
  computeEvGame,
  bestSoftQuote,
  positiveEvOpportunities,
  suspiciousOpportunities,
  buildFairValueBoard,
  closestSoftMatch,
  teamMatches,
} from "../fair-value";
import type { SharpEvent } from "../../../scripts/scrape-pinnacle";

function sharp(ml: { home: number; away: number }): SharpEvent {
  return {
    id: "pin_1",
    sport_key: "baseball_mlb",
    sport_title: "MLB",
    commence_time: "2026-06-05T00:10:00Z",
    home_team: "Houston Astros",
    away_team: "Pittsburgh Pirates",
    moneyline: ml,
  };
}

function soft(homePrice: number, awayPrice: number, book = "fanduel") {
  return {
    id: "fd_1",
    commence_time: "2026-06-05T00:10:00Z",
    home_team: "Houston Astros",
    away_team: "Pittsburgh Pirates",
    bookmakers: [
      {
        key: book,
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Houston Astros", price: homePrice },
              { name: "Pittsburgh Pirates", price: awayPrice },
            ],
          },
        ],
      },
    ],
  };
}

describe("teamMatches", () => {
  it("matches on full name and is token-aware", () => {
    expect(teamMatches("Houston Astros", "houston astros")).toBe(true);
    expect(teamMatches("Astros", "Houston Astros")).toBe(true);
    expect(teamMatches("New York Yankees", "New York Mets")).toBe(false);
  });
});

describe("bestSoftQuote", () => {
  it("picks the highest-payout price across books", () => {
    const ev = {
      id: "x",
      commence_time: "t",
      home_team: "Houston Astros",
      away_team: "Pittsburgh Pirates",
      bookmakers: [
        { key: "fanduel", markets: [{ key: "h2h", outcomes: [{ name: "Houston Astros", price: -120 }] }] },
        { key: "bovada", markets: [{ key: "h2h", outcomes: [{ name: "Houston Astros", price: -108 }] }] },
      ],
    };
    const q = bestSoftQuote(ev, "Houston Astros");
    expect(q!.american).toBe(-108); // -108 pays more than -120
    expect(q!.book).toBe("bovada");
  });
});

describe("computeEvGame — de-vig + EV", () => {
  it("symmetric sharp line → ~50/50 fair, and a soft +110 dog is +EV", () => {
    // Pinnacle pick'em -105/-105 de-vigs to ~50/50.
    const game = computeEvGame("MLB", sharp({ home: -105, away: -105 }), soft(-110, +110));
    expect(game).not.toBeNull();
    const away = game!.sides.find((s) => s.side === "away")!;
    // fair ~0.5, soft +110 implied ~0.476 → +EV
    expect(away.fairProb).toBeGreaterThan(0.49);
    expect(away.fairProb).toBeLessThan(0.51);
    expect(away.evPct!).toBeGreaterThan(0);
    expect(away.clvCents!).toBeGreaterThan(0); // bought better than fair
    // the home side at -110 vs ~50% fair is −EV
    const home = game!.sides.find((s) => s.side === "home")!;
    expect(home.evPct!).toBeLessThan(0);
  });

  it("no soft counterpart → null EV, no crash", () => {
    const game = computeEvGame("MLB", sharp({ home: -150, away: +130 }), null);
    expect(game).not.toBeNull();
    for (const s of game!.sides) {
      expect(s.bestSoft).toBeNull();
      expect(s.evPct).toBeNull();
      expect(s.kelly).toBe(0);
    }
  });

  it("a soft book that merely matches the vigged sharp price is −EV", () => {
    // Sharp -150/+130. Soft offering the SAME -150 favourite → you're paying
    // the favourite's vig, fair value is below the implied → −EV.
    const game = computeEvGame("MLB", sharp({ home: -150, away: +130 }), soft(-150, +130));
    const home = game!.sides.find((s) => s.side === "home")!;
    expect(home.evPct!).toBeLessThan(0);
  });
});

describe("positiveEvOpportunities", () => {
  it("returns only sides above the EV floor, sorted desc", () => {
    // away +110 vs ~50% fair ≈ +5% EV (playable); home -130 is −EV.
    const game = computeEvGame("MLB", sharp({ home: -105, away: -105 }), soft(-130, +110))!;
    const board = {
      league: "MLB",
      sharpFetchedAt: null,
      softFetchedAt: null,
      gamesMatched: 1,
      sharpGames: 1,
      softGames: 1,
      unmatched: [],
      games: [game],
    };
    const opps = positiveEvOpportunities(board, 0.02);
    // away at +135 vs ~50% fair is a fat +EV; home at -130 is −EV → filtered
    expect(opps.length).toBe(1);
    expect(opps[0].side).toBe("away");
    expect(opps[0].evPct!).toBeGreaterThan(0.02);
  });
});

describe("too-good-to-be-true quarantine", () => {
  it("flags an implausible edge as suspicious and keeps it out of plays", () => {
    // Sharp says coin flip (-105/-105 ≈ 50/50) but soft offers +250 — a 200¢
    // gap that's a stale/wrong-game line, not a real edge.
    const game = computeEvGame("MLB", sharp({ home: -105, away: -105 }), soft(-105, +250))!;
    const away = game.sides.find((s) => s.side === "away")!;
    expect(away.evPct!).toBeGreaterThan(0.06);
    expect(away.suspicious).toBe(true);

    const board = {
      league: "MLB",
      sharpFetchedAt: null,
      softFetchedAt: null,
      gamesMatched: 1,
      sharpGames: 1,
      softGames: 1,
      unmatched: [],
      games: [game],
    };
    expect(positiveEvOpportunities(board, 0.02)).toHaveLength(0); // not playable
    expect(suspiciousOpportunities(board)).toHaveLength(1); // quarantined
  });

  it("a modest, realistic +EV is NOT flagged suspicious", () => {
    // ~50% fair, soft +108 → EV ≈ +4% — a plausible real edge, under the ceiling.
    const game = computeEvGame("MLB", sharp({ home: -105, away: -105 }), soft(-105, +108))!;
    const away = game.sides.find((s) => s.side === "away")!;
    expect(away.evPct!).toBeGreaterThan(0); // real edge
    expect(away.evPct!).toBeLessThan(0.06);
    expect(away.suspicious).toBe(false);
  });
});

describe("closestSoftMatch — the doubleheader / wrong-day guard", () => {
  const sharpEv = sharp({ home: -110, away: +100 }); // commence 2026-06-05T00:10Z
  const tonight = {
    id: "fd_today",
    commence_time: "2026-06-04T00:10:00Z", // ~24h before the sharp game
    home_team: "Houston Astros",
    away_team: "Pittsburgh Pirates",
    bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [
      { name: "Houston Astros", price: -146 }, { name: "Pittsburgh Pirates", price: +114 },
    ] }] }],
  };
  const rightGame = {
    id: "fd_match",
    commence_time: "2026-06-05T00:16:00Z", // 6 min from the sharp game
    home_team: "Houston Astros",
    away_team: "Pittsburgh Pirates",
    bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [
      { name: "Houston Astros", price: -118 }, { name: "Pittsburgh Pirates", price: +100 },
    ] }] }],
  };

  it("picks the time-aligned game, not the same-teams game a day away", () => {
    // order matters: the wrong (earlier) game is listed first, as it was live.
    const match = closestSoftMatch(sharpEv, [tonight, rightGame]);
    expect(match!.id).toBe("fd_match");
  });

  it("returns null when no soft game is within the time window", () => {
    expect(closestSoftMatch(sharpEv, [tonight])).toBeNull();
  });
});

describe("buildFairValueBoard — missing files", () => {
  it("returns an empty board (no throw) when data dir has no files", () => {
    const board = buildFairValueBoard("MLB", { dataDir: "C:/nonexistent-dir-xyz" });
    expect(board.games).toEqual([]);
    expect(board.sharpGames).toBe(0);
    expect(board.softGames).toBe(0);
  });
});
