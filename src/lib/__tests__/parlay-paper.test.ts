// Unit tests for the parlay paper book (Experiment No. 4, PARLAY_PAPER_SPEC.md).
//
// Everything load-bearing here is PURE given its inputs — assembly, EV, stake,
// haircut, settlement, and accounting are decisions separated from the ESPN
// box-score effect — so the acceptance criteria are driven by fixtures with no
// network. The one impure piece (gradeOpenLegs) is not exercised here; the
// settlement math it feeds (settleFromLegs / settleParlays) is tested directly
// by writing leg statuses, exactly as a graded book would.

import { describe, it, expect } from "vitest";
import {
  assembleParlays,
  buildCandidates,
  computeStats,
  combinedDecimal,
  combinedFairProb,
  parlayExpectedValue,
  parlayStake,
  survivesHaircut,
  flipDelta,
  legsCorrelated,
  legKey,
  parlayId,
  settleFromLegs,
  settleParlays,
  PARLAY_PAPER_CONFIG,
  type CandidateLeg,
  type ParlayBet,
  type ParlayLeg,
  type ParlayPaperBook,
  type SkipTally,
} from "../parlay-paper";
import { americanToDecimal } from "../devig";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FUTURE = "2026-06-20T23:10:00Z";
const NOW_BEFORE = new Date("2026-06-20T20:00:00Z").getTime(); // 3h before commence
const NOW_AFTER = new Date("2026-06-21T03:00:00Z").getTime(); // after commence

function emptyBook(): ParlayPaperBook {
  return { updatedAt: "", parlays: [], ledger: [] };
}

function emptyTally(): SkipTally {
  return {
    started: 0,
    noGameId: 0,
    sameGame: 0,
    correlated: 0,
    negEV: 0,
    haircut: 0,
    tooSmall: 0,
    dup: 0,
    legReused: 0,
  };
}

let seq = 0;
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Encode n as an all-letter string (a, b, …, z, aa, ab, …). The correlation
 *  rule normalizes players to [a-z] only — digit-bearing names like "Player 1"
 *  collapse to "player" and read as the SAME player, so default fixture names
 *  must be letters-only to stay independent. */
function letters(n: number): string {
  let s = "";
  do {
    s = ALPHA[n % 26] + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** A playable +EV candidate leg. Defaults: fair 0.55 @ +120 → +21% leg EV. */
function cand(over: Partial<CandidateLeg> = {}): CandidateLeg {
  seq++;
  const player = over.player ?? `Player ${letters(seq)}`;
  const propType = over.propType ?? "Strikeouts";
  const side = over.side ?? "Over";
  const line = over.line ?? 5.5;
  const book = over.book ?? "betus";
  const gameId = over.gameId ?? `game-${seq}`;
  const oddsAmerican = over.oddsAmerican ?? 120;
  return {
    legId:
      over.legId ?? legKey({ player, propType, side, line, book, gameId }),
    player,
    gameId,
    team: over.team,
    opponent: over.opponent,
    propType,
    line,
    side,
    oddsAmerican,
    book,
    fairProb: over.fairProb ?? 0.55,
    commence: over.commence ?? FUTURE,
    league: over.league ?? "MLB",
  };
}

/** Materialize a candidate into a ParlayLeg with a settlement status. */
function leg(c: CandidateLeg, status: ParlayLeg["status"] = "open"): ParlayLeg {
  return {
    legId: c.legId,
    player: c.player,
    gameId: c.gameId,
    team: c.team,
    opponent: c.opponent,
    propType: c.propType,
    line: c.line,
    side: c.side,
    oddsAmerican: c.oddsAmerican,
    book: c.book,
    fairProb: c.fairProb,
    decimal: americanToDecimal(c.oddsAmerican),
    commence: c.commence,
    league: c.league,
    status,
    actual: null,
    finalScore: null,
  };
}

function parlayFromLegs(legs: ParlayLeg[], stakeUsd = 100): ParlayBet {
  const dec = combinedDecimal(legs);
  const prob = combinedFairProb(legs);
  return {
    id: parlayId(legs.map((l) => l.legId)),
    openedAt: "2026-06-20T20:00:00Z",
    legs,
    survivingLegIds: legs.map((l) => l.legId),
    parlayDecimalOdds: dec,
    parlayFairProb: prob,
    parlayEV: parlayExpectedValue(legs),
    flipDelta: flipDelta(legs),
    stakeUsd,
    status: "open",
    pnlUsd: null,
    settledAt: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — distinct games / missing gameId
// ─────────────────────────────────────────────────────────────────────────────

describe("AC1 — distinct games gate the parlay", () => {
  it("three legs in the SAME gameId produce 0 parlays (same-game)", () => {
    const trio = [
      cand({ player: "A", gameId: "g1", team: "Team Alpha" }),
      cand({ player: "B", gameId: "g1", team: "Team Beta" }),
      cand({ player: "C", gameId: "g1", team: "Team Gamma" }),
    ];
    const tally = emptyTally();
    const { parlays } = assembleParlays(trio, new Set(), new Set(), 10_000, tally);
    expect(parlays).toHaveLength(0);
    expect(tally.sameGame).toBeGreaterThanOrEqual(1);
  });

  it("same commence time but THREE distinct gameIds yields a valid parlay", () => {
    const trio = [
      cand({ player: "A", gameId: "g1", team: "Team Alpha", commence: FUTURE }),
      cand({ player: "B", gameId: "g2", team: "Team Beta", commence: FUTURE }),
      cand({ player: "C", gameId: "g3", team: "Team Gamma", commence: FUTURE }),
    ];
    const { parlays } = assembleParlays(trio, new Set(), new Set(), 10_000);
    expect(parlays).toHaveLength(1);
    expect(new Set(parlays[0].legs.map((l) => l.gameId)).size).toBe(3);
  });

  it("a leg with no gameId is excluded from candidacy (buildCandidates) and counted", () => {
    const tally = emptyTally();
    const rows = [
      { ts: "t1", player: "A", propType: "Strikeouts", line: 5.5, side: "Over", book: "betus", softAmerican: 120, fairProb: 0.55, evPct: 21, playable: true, commence: FUTURE, gameId: "g1" },
      { ts: "t1", player: "B", propType: "Strikeouts", line: 5.5, side: "Over", book: "betus", softAmerican: 120, fairProb: 0.55, evPct: 21, playable: true, commence: FUTURE /* no gameId */ },
    ] as Parameters<typeof buildCandidates>[0];
    const out = buildCandidates(rows, NOW_BEFORE, tally);
    expect(out).toHaveLength(1);
    expect(out[0].gameId).toBe("g1");
    expect(tally.noGameId).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — correlation block
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2 — correlated legs are refused", () => {
  it("a same-team stack (offense correlated) is flagged correlated", () => {
    const a = cand({ player: "Batter One", gameId: "g1", team: "New York Yankees", propType: "TotalBases" });
    const b = cand({ player: "Batter Two", gameId: "g2", team: "New York Yankees", propType: "TotalBases" });
    expect(legsCorrelated(a, b)).toBe(true);
  });

  it("the same player's two props are correlated", () => {
    const a = cand({ player: "Aaron Judge", gameId: "g1", propType: "HomeRuns", team: "NYY" });
    const b = cand({ player: "Aaron Judge", gameId: "g2", propType: "TotalBases", team: "BOS" });
    expect(legsCorrelated(a, b)).toBe(true);
  });

  it("a pitcher-K leg + an opposing-batter leg in the SAME game is refused with `correlated`", () => {
    // Pitcher and the batter he faces share a gameId → same-game; the assembler
    // first needs distinct games, so we pad with a third distinct-game leg and a
    // legal alternative, and assert the correlated/same-game trio never opens.
    const pitcher = cand({ player: "Gerrit Cole", gameId: "g1", propType: "Strikeouts", team: "New York Yankees" });
    const oppBatter = cand({ player: "Rafael Devers", gameId: "g1", propType: "TotalBases", team: "Boston Red Sox" });
    const third = cand({ player: "Solo Leg", gameId: "g2", propType: "Strikeouts", team: "Chicago Cubs" });
    const tally = emptyTally();
    const { parlays } = assembleParlays([pitcher, oppBatter, third], new Set(), new Set(), 10_000, tally);
    // pitcher+oppBatter share g1 → only 2 distinct games → can never form a trio.
    expect(parlays).toHaveLength(0);
    // The trio (pitcher, oppBatter, third) is caught by same-game (g1 twice).
    expect(tally.sameGame + tally.correlated).toBeGreaterThanOrEqual(1);
  });

  it("a cross-game pitcher-K vs batter on DIFFERENT teams is independent (allowed)", () => {
    const pitcher = cand({ player: "Gerrit Cole", gameId: "g1", propType: "Strikeouts", team: "New York Yankees" });
    const batter = cand({ player: "Mookie Betts", gameId: "g2", propType: "TotalBases", team: "Los Angeles Dodgers" });
    expect(legsCorrelated(pitcher, batter)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — EV, stake, open gates
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3 — EV is exact, stake is ¼-Kelly on the combination, gates hold", () => {
  it("parlayEV === Π(p_i·dec_i) − 1 (±1e-9)", () => {
    const legs = [
      leg(cand({ fairProb: 0.55, oddsAmerican: 120, gameId: "g1" })),
      leg(cand({ fairProb: 0.6, oddsAmerican: 110, gameId: "g2" })),
      leg(cand({ fairProb: 0.5, oddsAmerican: 150, gameId: "g3" })),
    ];
    const expected =
      0.55 * americanToDecimal(120) *
        0.6 * americanToDecimal(110) *
        0.5 * americanToDecimal(150) -
      1;
    expect(parlayExpectedValue(legs)).toBeCloseTo(expected, 9);
  });

  it("stake is the ¼-Kelly of the COMBINED prob/odds — not the per-leg product", () => {
    const legs = [
      leg(cand({ fairProb: 0.6, oddsAmerican: 120, gameId: "g1" })),
      leg(cand({ fairProb: 0.6, oddsAmerican: 120, gameId: "g2" })),
      leg(cand({ fairProb: 0.6, oddsAmerican: 120, gameId: "g3" })),
    ];
    const prob = combinedFairProb(legs);
    const dec = combinedDecimal(legs);
    const stake = parlayStake(prob, dec, 10_000);

    // hand-recompute ¼-Kelly on the combined market. parlayStake routes the
    // combined decimal through decimalToAmerican→americanToDecimal (the book
    // bets a posted american price), so a few cents of integer-rounding slack
    // is expected — assert to the dollar, not the cent.
    const b = dec - 1;
    const full = (b * prob - (1 - prob)) / b;
    const expectedRaw = Math.max(0, full * PARLAY_PAPER_CONFIG.kellyMultiplier) * 10_000;
    const expectedCapped = Math.min(
      expectedRaw,
      PARLAY_PAPER_CONFIG.maxStakePctEquity * 10_000,
    );
    expect(stake).toBeCloseTo(+expectedCapped.toFixed(2), 0);

    // and it must NOT equal the (wrong) product of per-leg Kelly fractions
    const perLegProduct =
      [0.6, 0.6, 0.6].reduce((acc, p) => {
        const lb = americanToDecimal(120) - 1;
        const f = Math.max(0, ((lb * p - (1 - p)) / lb) * 0.25);
        return acc * f;
      }, 1) * 10_000;
    expect(stake).not.toBeCloseTo(perLegProduct, 2);
  });

  it("caps stake at maxStakePctEquity and floors tiny stakes to 0", () => {
    // very strong combined edge → cap binds
    const strong = parlayStake(0.6, 4.0, 10_000);
    expect(strong).toBeLessThanOrEqual(PARLAY_PAPER_CONFIG.maxStakePctEquity * 10_000 + 0.01);
    // tiny equity → below the $10 floor → 0
    expect(parlayStake(0.6, 4.0, 50)).toBe(0);
    // no edge → 0
    expect(parlayStake(0.2, 2.0, 10_000)).toBe(0);
  });

  it("a parlay with parlayEV ≤ 0 never opens (neg-EV)", () => {
    // three legs each at a vig price with fair prob below break-even → product < 1
    const trio = [
      cand({ fairProb: 0.45, oddsAmerican: -110, gameId: "g1", team: "T1" }),
      cand({ fairProb: 0.45, oddsAmerican: -110, gameId: "g2", team: "T2" }),
      cand({ fairProb: 0.45, oddsAmerican: -110, gameId: "g3", team: "T3" }),
    ];
    const tally = emptyTally();
    const { parlays } = assembleParlays(trio, new Set(), new Set(), 10_000, tally);
    expect(parlays).toHaveLength(0);
    expect(tally.negEV).toBeGreaterThanOrEqual(1);
  });

  it("a +EV parlay that FAILS the −4pt haircut never opens (haircut)", () => {
    // Pick legs that are +EV at face but flip negative under a −4pt-per-leg cut.
    // fair 0.52 @ +100 (dec 2.0): product = (0.52*2)^3 = 1.04^3 ≈ 1.1249 → +12.5% EV.
    // After −0.04: (0.48*2)^3 = 0.96^3 ≈ 0.884 → −11.5% EV → must be rejected.
    const trio = [
      cand({ fairProb: 0.52, oddsAmerican: 100, gameId: "g1", team: "T1" }),
      cand({ fairProb: 0.52, oddsAmerican: 100, gameId: "g2", team: "T2" }),
      cand({ fairProb: 0.52, oddsAmerican: 100, gameId: "g3", team: "T3" }),
    ];
    const legs = trio.map((c) => leg(c));
    expect(parlayExpectedValue(legs)).toBeGreaterThan(0); // +EV at face
    expect(survivesHaircut(legs, PARLAY_PAPER_CONFIG.haircutPerLegProb)).toBe(false);

    const tally = emptyTally();
    const { parlays } = assembleParlays(trio, new Set(), new Set(), 10_000, tally);
    expect(parlays).toHaveLength(0);
    expect(tally.haircut).toBeGreaterThanOrEqual(1);
  });

  it("records a flip-δ that zeroes parlayEV (estimation-error guard)", () => {
    const legs = [
      leg(cand({ fairProb: 0.6, oddsAmerican: 120, gameId: "g1" })),
      leg(cand({ fairProb: 0.6, oddsAmerican: 120, gameId: "g2" })),
      leg(cand({ fairProb: 0.6, oddsAmerican: 120, gameId: "g3" })),
    ];
    const d = flipDelta(legs);
    expect(d).toBeGreaterThan(0);
    // EV at the flip-δ is ~0
    const haircutLegs = legs.map((l) => ({ ...l, fairProb: l.fairProb - d }));
    expect(parlayExpectedValue(haircutLegs)).toBeCloseTo(0, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — settlement (win / loss / push-recombine / all-void / stays-open)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC4 — settlement math", () => {
  function trioLegs(): CandidateLeg[] {
    return [
      cand({ player: "A", gameId: "g1", oddsAmerican: 120, fairProb: 0.55 }),
      cand({ player: "B", gameId: "g2", oddsAmerican: 110, fairProb: 0.6 }),
      cand({ player: "C", gameId: "g3", oddsAmerican: 150, fairProb: 0.5 }),
    ];
  }

  it("all legs won → P&L = stake · (decPar − 1)", () => {
    const legs = trioLegs().map((c) => leg(c, "won"));
    const p = parlayFromLegs(legs, 100);
    const res = settleFromLegs(p)!;
    const decPar = combinedDecimal(legs);
    expect(res.status).toBe("won");
    expect(res.pnlUsd).toBeCloseTo(+(100 * (decPar - 1)).toFixed(2), 2);
    expect(res.survivingLegIds).toHaveLength(3);
  });

  it("any leg lost → P&L = −stake (full loss)", () => {
    const legs = trioLegs().map((c, i) => leg(c, i === 1 ? "lost" : "won"));
    const p = parlayFromLegs(legs, 100);
    const res = settleFromLegs(p)!;
    expect(res.status).toBe("lost");
    expect(res.pnlUsd).toBe(-100);
    expect(res.survivingLegIds).toHaveLength(0);
  });

  it("one PUSH leg drops out and the parlay re-prices to the surviving legs", () => {
    const cs = trioLegs();
    const legs = [leg(cs[0], "won"), leg(cs[1], "push"), leg(cs[2], "won")];
    const p = parlayFromLegs(legs, 100);
    const res = settleFromLegs(p)!;
    expect(res.status).toBe("won");
    // recombined on legs 0 and 2 only
    const survivorsDec = americanToDecimal(120) * americanToDecimal(150);
    expect(res.pnlUsd).toBeCloseTo(+(100 * (survivorsDec - 1)).toFixed(2), 2);
    expect(res.survivingLegIds).toEqual([cs[0].legId, cs[2].legId]);
  });

  it("one VOID leg drops out exactly like a push (scratch / postpone)", () => {
    const cs = trioLegs();
    const legs = [leg(cs[0], "won"), leg(cs[1], "void"), leg(cs[2], "won")];
    const res = settleFromLegs(parlayFromLegs(legs, 100))!;
    expect(res.status).toBe("won");
    expect(res.survivingLegIds).toEqual([cs[0].legId, cs[2].legId]);
  });

  it("all legs push/void → status `void`, full refund (P&L 0)", () => {
    const legs = trioLegs().map((c) => leg(c, "void"));
    const res = settleFromLegs(parlayFromLegs(legs, 100))!;
    expect(res.status).toBe("void");
    expect(res.pnlUsd).toBe(0);
    expect(res.survivingLegIds).toHaveLength(0);
  });

  it("2 won + 1 still open → stays open, contributes nothing", () => {
    const cs = trioLegs();
    const legs = [leg(cs[0], "won"), leg(cs[1], "won"), leg(cs[2], "open")];
    const p = parlayFromLegs(legs, 100);
    expect(settleFromLegs(p)).toBeNull();

    const book = emptyBook();
    book.parlays.push(p);
    const settled = settleParlays(book, NOW_AFTER);
    expect(settled).toBe(0);
    expect(p.status).toBe("open");

    const s = computeStats(book);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.winRatePct).toBeNull();
  });

  it("settleParlays writes status/pnl/survivors and counts only terminal parlays", () => {
    const won = parlayFromLegs(trioLegs().map((c) => leg(c, "won")), 100);
    const lost = parlayFromLegs(
      [cand({ player: "X", gameId: "g4" }), cand({ player: "Y", gameId: "g5" }), cand({ player: "Z", gameId: "g6" })].map(
        (c, i) => leg(c, i === 0 ? "lost" : "won"),
      ),
      200,
    );
    const book = emptyBook();
    book.parlays.push(won, lost);
    const n = settleParlays(book, NOW_AFTER);
    expect(n).toBe(2);
    expect(won.status).toBe("won");
    expect(lost.status).toBe("lost");
    expect(lost.pnlUsd).toBe(-200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — look-ahead, idempotency, disjoint exposure, accounting
// ─────────────────────────────────────────────────────────────────────────────

describe("AC5 — look-ahead, idempotency, exposure, accounting", () => {
  it("a leg whose commence ≤ now is excluded (no look-ahead)", () => {
    const rows = [
      { ts: "t1", player: "A", propType: "Strikeouts", line: 5.5, side: "Over", book: "betus", softAmerican: 120, fairProb: 0.55, evPct: 21, playable: true, commence: FUTURE, gameId: "g1" },
      { ts: "t1", player: "B", propType: "Strikeouts", line: 5.5, side: "Over", book: "betus", softAmerican: 120, fairProb: 0.55, evPct: 21, playable: true, commence: "2026-06-20T19:00:00Z", gameId: "g2" }, // already started at NOW_BEFORE
    ] as Parameters<typeof buildCandidates>[0];
    const out = buildCandidates(rows, NOW_BEFORE, emptyTally());
    expect(out.map((c) => c.gameId)).toEqual(["g1"]);
  });

  it("buildCandidates dedups to the LATEST tick per (player,propType,side,line,book)", () => {
    const rows = [
      { ts: "2026-06-20T18:00:00Z", player: "A", propType: "Strikeouts", line: 5.5, side: "Over", book: "betus", softAmerican: 110, fairProb: 0.5, evPct: 5, playable: true, commence: FUTURE, gameId: "g1" },
      { ts: "2026-06-20T19:30:00Z", player: "A", propType: "Strikeouts", line: 5.5, side: "Over", book: "betus", softAmerican: 130, fairProb: 0.55, evPct: 26, playable: true, commence: FUTURE, gameId: "g1" },
    ] as Parameters<typeof buildCandidates>[0];
    const out = buildCandidates(rows, NOW_BEFORE, emptyTally());
    expect(out).toHaveLength(1);
    expect(out[0].oddsAmerican).toBe(130); // the later tick won
  });

  it("re-running the same slate opens no duplicate (deterministic id)", () => {
    const trio = [
      cand({ player: "A", gameId: "g1", team: "T1" }),
      cand({ player: "B", gameId: "g2", team: "T2" }),
      cand({ player: "C", gameId: "g3", team: "T3" }),
    ];
    const first = assembleParlays(trio, new Set(), new Set(), 10_000);
    expect(first.parlays).toHaveLength(1);
    const openId = first.parlays[0].id;

    // second run with the same slate, but now the id is already on the book
    const tally = emptyTally();
    const second = assembleParlays(trio, new Set(), new Set([openId]), 10_000, tally);
    expect(second.parlays).toHaveLength(0);
    expect(tally.dup).toBeGreaterThanOrEqual(1);
  });

  it("each leg lands in at most one open parlay (no exposure double-count)", () => {
    // 4 distinct-game legs → only ONE disjoint triple can form; the 4th leg is
    // left unused rather than reused across two parlays.
    const four = [
      cand({ player: "A", gameId: "g1", team: "T1" }),
      cand({ player: "B", gameId: "g2", team: "T2" }),
      cand({ player: "C", gameId: "g3", team: "T3" }),
      cand({ player: "D", gameId: "g4", team: "T4" }),
    ];
    const { parlays } = assembleParlays(four, new Set(), new Set(), 10_000);
    expect(parlays).toHaveLength(1);
    const usedLegIds = parlays.flatMap((p) => p.legs.map((l) => l.legId));
    expect(new Set(usedLegIds).size).toBe(usedLegIds.length); // no leg twice
  });

  it("a leg already committed in an OPEN parlay is not reused", () => {
    const shared = cand({ player: "Shared", gameId: "g1", team: "T1" });
    const trio = [
      shared,
      cand({ player: "B", gameId: "g2", team: "T2" }),
      cand({ player: "C", gameId: "g3", team: "T3" }),
    ];
    // shared.legId is already used by an open parlay → can't anchor a new one
    const { parlays } = assembleParlays(trio, new Set([shared.legId]), new Set(), 10_000);
    expect(parlays).toHaveLength(0);
  });

  it("exposure = Σ open stakes; equity = 10000 + Σ settled P&L; unsettled excluded from win-rate", () => {
    const book = emptyBook();
    // one open parlay (exposure), one won, one lost
    const openP = parlayFromLegs(
      [cand({ player: "O1", gameId: "g1" }), cand({ player: "O2", gameId: "g2" }), cand({ player: "O3", gameId: "g3" })].map((c) => leg(c, "open")),
      300,
    );
    const wonP = { ...parlayFromLegs([cand({ player: "W1", gameId: "g4" }), cand({ player: "W2", gameId: "g5" }), cand({ player: "W3", gameId: "g6" })].map((c) => leg(c, "won")), 100), status: "won" as const, pnlUsd: 250, settledAt: "t" };
    const lostP = { ...parlayFromLegs([cand({ player: "L1", gameId: "g7" }), cand({ player: "L2", gameId: "g8" }), cand({ player: "L3", gameId: "g9" })].map((c) => leg(c, "lost")), 100), status: "lost" as const, pnlUsd: -100, settledAt: "t" };
    book.parlays.push(openP, wonP, lostP);

    const s = computeStats(book);
    expect(s.exposureUsd).toBe(300); // only the open parlay
    expect(s.realizedPnlUsd).toBe(150); // 250 − 100
    expect(s.equityUsd).toBe(PARLAY_PAPER_CONFIG.startingBankrollUsd + 150);
    expect(s.cashUsd).toBe(+(s.equityUsd - 300).toFixed(2));
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.openCount).toBe(1);
    expect(s.winRatePct).toBe(50); // open parlay excluded from win-rate
    expect(s.totalStakedUsd).toBe(200); // decisive only
  });

  it("a full-void parlay refunds: not counted in staked, equity unchanged by it", () => {
    const book = emptyBook();
    const voidP = { ...parlayFromLegs([cand({ player: "V1", gameId: "g1" }), cand({ player: "V2", gameId: "g2" }), cand({ player: "V3", gameId: "g3" })].map((c) => leg(c, "void")), 100), status: "void" as const, pnlUsd: 0, settledAt: "t" };
    book.parlays.push(voidP);
    const s = computeStats(book);
    expect(s.voids).toBe(1);
    expect(s.totalStakedUsd).toBe(0); // refunded, not decisive
    expect(s.realizedPnlUsd).toBe(0);
    expect(s.equityUsd).toBe(PARLAY_PAPER_CONFIG.startingBankrollUsd);
  });
});
