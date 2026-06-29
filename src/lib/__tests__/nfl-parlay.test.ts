import { describe, it, expect } from "vitest";
import {
  toEligibleLegs,
  assembleWeekParlays,
  gradeParlay,
  runNflParlayBacktest,
  computeNflParlayStats,
  survivesHaircut,
  combinedDecimal,
  combinedFairProb,
  emptyTally,
  NFL_PARLAY_CONFIG,
  type NflParlayLeg,
} from "../nfl-parlay";
import type { GradedRow, GradedPropRow } from "../nfl-loop";

// ── Fixtures (NOT the live logs — see the task's concurrency note) ───────────

function gameRow(over: Partial<GradedRow> = {}): GradedRow {
  return {
    key: `${over.gameId ?? "G1"}|${over.market ?? "moneyline"}`,
    season: 2024,
    phase: "REG",
    week: 1,
    gameId: "G1",
    matchup: "AWAY @ HOME",
    market: "moneyline",
    selection: "HOME ML",
    side: "home",
    confidence: 0.7, // model prob
    result: "win",
    oddsAmerican: -150, // implied ≈ 0.60 → edge ≈ +0.10 (favorite, +EV)
    pnlUnits: 0,
    favored: "favorite",
    homeAway: "home",
    divGame: false,
    dome: false,
    restAdvantage: 0,
    wind: null,
    temp: null,
    gradedAt: "2024-09-08T00:00:00.000Z",
    ...over,
  };
}

function propRow(over: Partial<GradedPropRow> = {}): GradedPropRow {
  return {
    key: `${over.gameId ?? "G1"}|${over.player ?? "Player"}|${over.stat ?? "passYds"}`,
    season: 2024,
    phase: "REG",
    week: 1,
    gameId: "G1",
    player: "Player",
    team: "HOME",
    position: "QB",
    stat: "passYds",
    threshold: 250,
    side: "over",
    confidence: 0.7, // edge vs -110 (implied ≈ 0.524) ≈ +0.176
    actualValue: 300,
    result: "win",
    rationale: "fixture",
    gradedAt: "2024-09-08T00:00:00.000Z",
    ...over,
  };
}

/** Three distinct-game, +EV, favorite legs that survive the haircut. */
function trioLegs(): NflParlayLeg[] {
  const games: GradedRow[] = [
    gameRow({ gameId: "G1", key: "G1|moneyline", confidence: 0.72 }),
    gameRow({ gameId: "G2", key: "G2|moneyline", confidence: 0.72 }),
    gameRow({ gameId: "G3", key: "G3|moneyline", confidence: 0.72 }),
  ];
  return toEligibleLegs(games, []);
}

// ── +EV floor gate ───────────────────────────────────────────────────────────

describe("toEligibleLegs — +EV floor", () => {
  it("keeps a leg whose modelProb beats implied by ≥3%", () => {
    // -150 → implied ≈0.60; confidence 0.70 → edge ≈+0.10 ≥ 0.03
    const legs = toEligibleLegs([gameRow({ confidence: 0.7, oddsAmerican: -150 })], []);
    expect(legs).toHaveLength(1);
    expect(legs[0].edge).toBeGreaterThanOrEqual(NFL_PARLAY_CONFIG.edgeFloor);
  });

  it("drops a leg below the 3% edge floor", () => {
    const tally = emptyTally();
    // -150 → implied ≈0.60; confidence 0.61 → edge ≈+0.01 < 0.03
    const legs = toEligibleLegs([gameRow({ confidence: 0.61, oddsAmerican: -150 })], [], tally);
    expect(legs).toHaveLength(0);
    expect(tally.belowEdgeFloor).toBe(1);
  });

  it("grades props at -110 when the row carries no odds", () => {
    // -110 implied ≈0.524; confidence 0.60 → edge ≈+0.076
    const legs = toEligibleLegs([], [propRow({ confidence: 0.6 })]);
    expect(legs).toHaveLength(1);
    expect(legs[0].oddsAmerican).toBe(-110);
    expect(legs[0].edge).toBeGreaterThanOrEqual(NFL_PARLAY_CONFIG.edgeFloor);
  });
});

// ── Longshot exclusion ─────────────────────────────────────────────────────────

describe("toEligibleLegs — longshot exclusion", () => {
  it("excludes a leg priced longer than +150 even if it clears the edge floor", () => {
    const tally = emptyTally();
    // +200 → implied ≈0.333; confidence 0.45 → edge ≈+0.117 (would pass EV) but +200 > +150
    const legs = toEligibleLegs([gameRow({ confidence: 0.45, oddsAmerican: 200 })], [], tally);
    expect(legs).toHaveLength(0);
    expect(tally.longshot).toBe(1);
  });

  it("keeps a leg priced exactly +150 (boundary inclusive)", () => {
    // +150 → implied ≈0.40; confidence 0.50 → edge ≈+0.10
    const legs = toEligibleLegs([gameRow({ confidence: 0.5, oddsAmerican: 150 })], []);
    expect(legs).toHaveLength(1);
  });
});

// ── no-data exclusion ──────────────────────────────────────────────────────────

describe("toEligibleLegs — no-data props excluded", () => {
  it("never forms a leg on an ungraded (no-data) prop", () => {
    const tally = emptyTally();
    const legs = toEligibleLegs([], [propRow({ result: "no-data", confidence: 0.9 })], tally);
    expect(legs).toHaveLength(0);
    expect(tally.noData).toBe(1);
    expect(tally.eligibleLegs).toBe(0);
  });
});

// ── distinct-game gate ─────────────────────────────────────────────────────────

describe("assembleWeekParlays — distinct-game gate", () => {
  it("never combines two legs from the same gameId (game+prop correlation too)", () => {
    // game leg + prop leg share G1 → only 2 distinct games among 3 legs → blocked.
    const legs = toEligibleLegs(
      [
        gameRow({ gameId: "G1", key: "G1|moneyline" }),
        gameRow({ gameId: "G2", key: "G2|moneyline" }),
      ],
      [propRow({ gameId: "G1", player: "QB1" })], // same game as the G1 ML leg
    );
    expect(legs).toHaveLength(3);
    const tally = emptyTally();
    const parlays = assembleWeekParlays(legs, 10_000, tally);
    expect(parlays).toHaveLength(0);
    expect(tally.sameGame).toBeGreaterThanOrEqual(1);
  });

  it("forms exactly one parlay from three distinct-game favorite legs", () => {
    const parlays = assembleWeekParlays(trioLegs(), 10_000);
    expect(parlays).toHaveLength(1);
    expect(new Set(parlays[0].legs.map((l) => l.gameId)).size).toBe(3);
  });
});

// ── haircut survival gate ──────────────────────────────────────────────────────

describe("survivesHaircut / assembleWeekParlays — haircut", () => {
  it("survivesHaircut is true for a fat-edge trio, false after a punishing shave", () => {
    const legs = trioLegs(); // modelProb 0.72 @ -150 (dec 1.667)
    expect(survivesHaircut(legs, 0.04)).toBe(true);
    expect(survivesHaircut(legs, 0.2)).toBe(false);
  });

  it("blocks a trio that is +EV raw but fails the −4pt haircut", () => {
    // Three legs each barely +EV: -110 (dec ≈1.909), modelProb 0.555.
    // raw Π(p·dec) ≈ 1.06^3-ish >1, but shaving 0.04 each (→0.515) dips ≤1.
    const rows: GradedRow[] = [
      gameRow({ gameId: "G1", key: "G1|moneyline", confidence: 0.555, oddsAmerican: -110 }),
      gameRow({ gameId: "G2", key: "G2|moneyline", confidence: 0.555, oddsAmerican: -110 }),
      gameRow({ gameId: "G3", key: "G3|moneyline", confidence: 0.555, oddsAmerican: -110 }),
    ];
    const legs = toEligibleLegs(rows, []);
    expect(legs).toHaveLength(3); // edge ≈ +0.031 ≥ 0.03 → eligible
    expect(survivesHaircut(legs, 0.04)).toBe(false);
    const tally = emptyTally();
    const parlays = assembleWeekParlays(legs, 10_000, tally);
    expect(parlays).toHaveLength(0);
    expect(tally.haircut).toBeGreaterThanOrEqual(1);
  });
});

// ── grading ─────────────────────────────────────────────────────────────────

describe("gradeParlay", () => {
  it("wins only when ALL legs won", () => {
    const legs = trioLegs().map((l) => ({ ...l, result: "win" as const }));
    const { status, pnlUsd } = gradeParlay(legs, 100);
    expect(status).toBe("won");
    // payout = stake * (Πdec − 1); dec 1.6667^3 ≈ 4.63 → pnl ≈ 363
    expect(pnlUsd).toBeGreaterThan(0);
  });

  it("any leg loss → parlay lost (−stake)", () => {
    const legs = trioLegs();
    legs[1] = { ...legs[1], result: "loss" };
    const { status, pnlUsd } = gradeParlay(legs, 100);
    expect(status).toBe("lost");
    expect(pnlUsd).toBe(-100);
  });

  it("a push leg drops out and the parlay re-prices to the survivors", () => {
    const legs: NflParlayLeg[] = trioLegs().map((l) => ({ ...l, result: "win" }));
    legs[2] = { ...legs[2], result: "push" };
    const { status, pnlUsd } = gradeParlay(legs, 100);
    expect(status).toBe("won");
    // survivors = 2 legs at dec 1.6667 → 100*(1.6667^2 − 1) ≈ 177.78
    expect(pnlUsd).toBeCloseTo(177.78, 1);
  });

  it("all-push → void with zero P&L", () => {
    const legs = trioLegs().map((l) => ({ ...l, result: "push" as const }));
    const { status, pnlUsd } = gradeParlay(legs, 100);
    expect(status).toBe("void");
    expect(pnlUsd).toBe(0);
  });
});

// ── NO-LEAKAGE: selection must never read `result` ─────────────────────────────

describe("no-leakage — leg selection ignores result", () => {
  it("flipping every leg's result does not change which parlays are formed", () => {
    // Build a pool with more eligible legs than one parlay needs, so selection
    // ORDER matters. Then assemble twice: once with the real results, once with
    // every result inverted. The SET of formed parlays (by id) must be identical —
    // proving assembly ranked on edge/odds, never on win/loss.
    const rows: GradedRow[] = [];
    for (let g = 1; g <= 6; g++) {
      rows.push(
        gameRow({
          gameId: `G${g}`,
          key: `G${g}|moneyline`,
          confidence: 0.7 + g * 0.005, // distinct edges → deterministic ranking
          oddsAmerican: -140,
          result: g % 2 === 0 ? "win" : "loss",
        }),
      );
    }
    const legs = toEligibleLegs(rows, []);

    const flip = (r: NflParlayLeg["result"]): NflParlayLeg["result"] =>
      r === "win" ? "loss" : r === "loss" ? "win" : r;
    const flipped = legs.map((l) => ({ ...l, result: flip(l.result) }));

    const idsReal = assembleWeekParlays(legs, 10_000).map((p) => p.id).sort();
    const idsFlipped = assembleWeekParlays(flipped, 10_000).map((p) => p.id).sort();

    expect(idsReal.length).toBeGreaterThan(0);
    expect(idsFlipped).toEqual(idsReal);
  });
});

// ── per-week cap + drop logging ────────────────────────────────────────────────

describe("assembleWeekParlays — per-week cap", () => {
  it("caps parlays per week and logs the dropped eligible legs", () => {
    const rows: GradedRow[] = [];
    // 21 distinct-game favorite legs → 7 possible parlays, cap is 5.
    for (let g = 1; g <= 21; g++) {
      rows.push(
        gameRow({ gameId: `G${g}`, key: `G${g}|moneyline`, confidence: 0.72, oddsAmerican: -150 }),
      );
    }
    const legs = toEligibleLegs(rows, []);
    expect(legs).toHaveLength(21);
    const tally = emptyTally();
    const parlays = assembleWeekParlays(legs, 10_000, tally);
    expect(parlays).toHaveLength(NFL_PARLAY_CONFIG.maxParlaysPerWeek);
    // 21 legs − 5*3 used = 6 left on the table, counted (no silent truncation).
    expect(tally.cappedDropped).toBe(6);
    expect(tally.legsStranded).toBe(0); // cap bound → leftovers are capped, not stranded
  });

  it("reconciles eligible legs when the cap does NOT bind (stranded, not silent)", () => {
    // 4 distinct-game favorite legs → only 1 parlay forms (3 legs), 1 leg has no
    // partner. The cap (5) never binds, so that leftover must surface as
    // legsStranded — eligibleLegs == used + capped + stranded must hold.
    const rows: GradedRow[] = [];
    for (let g = 1; g <= 4; g++) {
      rows.push(
        gameRow({ gameId: `G${g}`, key: `G${g}|moneyline`, confidence: 0.72, oddsAmerican: -150 }),
      );
    }
    const tally = emptyTally();
    const legs = toEligibleLegs(rows, [], tally); // thread tally so eligibleLegs is counted
    expect(legs).toHaveLength(4);
    expect(tally.eligibleLegs).toBe(4);
    const parlays = assembleWeekParlays(legs, 10_000, tally);
    expect(parlays).toHaveLength(1);
    expect(tally.cappedDropped).toBe(0); // cap didn't bind
    expect(tally.legsStranded).toBe(1); // the 4th leg had no partner
    // full reconciliation: eligible == used + capped + stranded
    const used = parlays.length * 3;
    expect(used + tally.cappedDropped + tally.legsStranded).toBe(tally.eligibleLegs);
  });
});

// ── full backtest + stats ──────────────────────────────────────────────────────

describe("runNflParlayBacktest + computeNflParlayStats", () => {
  it("forms, grades, and aggregates a sparse multi-week book", () => {
    const games: GradedRow[] = [
      gameRow({ gameId: "G1", key: "G1|moneyline", week: 1, result: "win" }),
      gameRow({ gameId: "G2", key: "G2|moneyline", week: 1, result: "win" }),
      gameRow({ gameId: "G3", key: "G3|moneyline", week: 1, result: "loss" }),
      gameRow({ gameId: "H1", key: "H1|moneyline", week: 2, result: "win" }),
      gameRow({ gameId: "H2", key: "H2|moneyline", week: 2, result: "win" }),
      gameRow({ gameId: "H3", key: "H3|moneyline", week: 2, result: "win" }),
    ];
    const book = runNflParlayBacktest(games, [], "2026-06-14T00:00:00.000Z");
    expect(book.parlays).toHaveLength(2); // one per week
    const wk1 = book.parlays.find((p) => p.week === 1)!;
    const wk2 = book.parlays.find((p) => p.week === 2)!;
    expect(wk1.status).toBe("lost"); // G3 lost
    expect(wk2.status).toBe("won"); // all three won

    const stats = computeNflParlayStats(book);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.settledCount).toBe(2);
    expect(stats.avgLegsEdge).not.toBeNull();
    expect(stats.startingBankrollUsd).toBe(10_000);
  });

  it("returns an empty book (no parlays) when no week has 3 distinct eligible games", () => {
    const games = [gameRow({ gameId: "G1", key: "G1|moneyline" })];
    const book = runNflParlayBacktest(games, [], "2026-06-14T00:00:00.000Z");
    expect(book.parlays).toHaveLength(0);
    const stats = computeNflParlayStats(book);
    expect(stats.settledCount).toBe(0);
    expect(stats.avgLegsEdge).toBeNull();
    expect(stats.roiPct).toBe(0);
  });
});
